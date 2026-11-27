export { lastSegment, pathContains } from './paths.js';
export { mapKavitaPathToLocalPath, resolveSeriesHostDir, resolveSeriesHostDirAsync, type LibraryPathMapping } from '../kavita/libraryPaths.js';
import { randomUUID, createHash } from 'node:crypto';
import { archiveMutations, archiveResource, archiveResourceAsync } from './mutations.js';
import { mapLimit } from './http.js';
import { deflateRaw, inflateRaw, inflateRawSync } from 'node:zlib';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from './crc.js';
import { parseComicInfo, renderComicInfoXml } from '../downloader/comicinfo.js';

const deflateRawAsync = promisify(deflateRaw);
const inflateRawAsync = promisify(inflateRaw);

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
  flags: number;
  centralRecord: Buffer;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;
const NAME_COLLATOR = new Intl.Collator();
const EMPTY_BUF = Buffer.alloc(0);
const CD_CACHE_MAX = 32;
const cdCache = new Map<string, ZipEntryInfo[]>();

function getCachedCd(key: string): ZipEntryInfo[] | undefined {
  const cached = cdCache.get(key);
  if (!cached) return undefined;
  cdCache.delete(key);
  cdCache.set(key, cached);
  return cached;
}

function setCachedCd(key: string, entries: ZipEntryInfo[]): void {
  if (cdCache.has(key)) cdCache.delete(key);
  else if (cdCache.size >= CD_CACHE_MAX) {
    const oldest = cdCache.keys().next().value;
    if (oldest !== undefined) cdCache.delete(oldest);
  }
  cdCache.set(key, entries);
}

function invalidateCdCache(filePath: string): void {
  const prefix = `${path.resolve(filePath)}|`;
  for (const key of cdCache.keys()) {
    if (key.startsWith(prefix)) cdCache.delete(key);
  }
}

/** Parse `count` central-directory records starting at cd[0]. */
function parseCentralDirectory(cd: Buffer, count: number, keepCentralRecord = true): ZipEntryInfo[] {
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
    if (p+46+nameLen+extraLen+commentLen>cd.length) throw new Error('Corrupt ZIP (truncated central directory record)');
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
      flags: cd.readUInt16LE(p + 8),
      centralRecord: keepCentralRecord ? Buffer.from(cd.subarray(p, p + 46 + nameLen + extraLen + commentLen)) : EMPTY_BUF,
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
async function readZipEntriesFromDisk(fh: fs.promises.FileHandle, fileSize: number, keepCentralRecord = true): Promise<ZipEntryInfo[]> {
  return (await readZipDirectoryFromDisk(fh, fileSize, keepCentralRecord)).entries;
}

async function readCachedZipEntriesFromDisk(p: string, fh: fs.promises.FileHandle, stat: fs.Stats): Promise<ZipEntryInfo[]> {
  const key = `${path.resolve(p)}|${stat.mtimeMs}|${stat.size}`;
  const cached = getCachedCd(key);
  if (cached) return cached;
  const entries = await readZipEntriesFromDisk(fh, stat.size, false);
  setCachedCd(key, entries);
  return entries;
}

function findEocdOffset(tail: Buffer): number {
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
      return i;
    }
  }
  return -1;
}

async function readZipDirectoryFromDisk(fh: fs.promises.FileHandle, fileSize: number, keepCentralRecord = true): Promise<{ entries: ZipEntryInfo[]; comment: Buffer }> {
  const maxTailLen = Math.min(fileSize, 22 + 0xffff);
  const firstLen = Math.min(fileSize, 4096);
  let tail = Buffer.allocUnsafe(firstLen);
  await readFull(fh, tail, fileSize - firstLen);
  let eocd = findEocdOffset(tail);
  if (eocd < 0 && firstLen < maxTailLen) {
    tail = Buffer.allocUnsafe(maxTailLen);
    await readFull(fh, tail, fileSize - maxTailLen);
    eocd = findEocdOffset(tail);
  }
  if (eocd < 0) throw new Error('Not a ZIP file (end of central directory not found)');

  const count = tail.readUInt16LE(eocd + 10);
  const centralStart = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralStart === ZIP64_MARKER) {
    throw new Error('ZIP64 archives are not supported');
  }
  if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0 || tail.readUInt16LE(eocd + 8) !== count) throw new Error('Multi-disk ZIP archives are not supported');
  // The central directory ends exactly at the EOCD, so its extent is known
  // without trusting the size field.
  const tailOffset = fileSize - tail.length;
  const cdEnd = tailOffset + eocd;
  if (centralStart > cdEnd) throw new Error('Corrupt ZIP (central directory extends past EOCD)');
  let cd: Buffer;
  if (centralStart >= tailOffset) {
    cd = tail.subarray(centralStart - tailOffset, eocd);
  } else {
    cd = Buffer.allocUnsafe(cdEnd - centralStart);
    await readFull(fh, cd, centralStart);
  }
  return { entries: parseCentralDirectory(cd, count, keepCentralRecord), comment: Buffer.from(tail.subarray(eocd + 22)) };
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
const MIN_WINDOW = 64 * 1024;

/**
 * Positional reads served from one large read-ahead window, so walking an
 * archive's local headers, payloads and data descriptors in file order costs
 * one read syscall per window instead of several per entry. The bytes served
 * are exactly the file's bytes; callers keep all of their validation.
 *
 * With `hash`, every byte of the file is also fed into it exactly once and in
 * file order (gaps between requested ranges are read and hashed too), so a
 * single sequential pass can fingerprint the whole archive while its entries
 * are inspected. Call finishHash() to hash the remainder.
 */
class WindowedReader {
  private readonly window: Buffer;
  private start = 0;
  private end = 0;
  private hashedTo = 0;

  constructor(private readonly fh: fs.promises.FileHandle, private readonly size: number, private readonly hash?: ReturnType<typeof createHash>) {
    this.window = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK, Math.max(MIN_WINDOW, size))));
  }

  private contains(position: number, length: number): boolean {
    return position >= this.start && position + length <= this.end;
  }

  private async load(position: number, maxLen?: number): Promise<void> {
    const limit = this.hash && position < this.hashedTo
      ? Math.min(this.window.length, Math.max(MIN_WINDOW, maxLen ?? MIN_WINDOW))
      : this.window.length;
    const want = Math.max(0, Math.min(limit, this.size - position));
    let filled = 0;
    while (filled < want) {
      const { bytesRead } = await this.fh.read(this.window, filled, want - filled, position + filled);
      if (bytesRead <= 0) break;
      filled += bytesRead;
    }
    this.start = position;
    this.end = position + filled;
    if (filled < want) throw new Error('Unexpected EOF while reading ZIP');
    if (this.hash && position <= this.hashedTo && this.end > this.hashedTo) {
      this.hash.update(this.window.subarray(this.hashedTo - position, filled));
      this.hashedTo = this.end;
    }
  }

  /** View of [position, position+length); valid only until the next reader call. */
  async slice(position: number, length: number): Promise<Buffer> {
    if (length > this.window.length) {
      if (position + length > this.size) throw new Error('Unexpected EOF while reading ZIP');
      throw new Error('ZIP read exceeds the read-ahead window');
    }
    if (!this.contains(position, length)) {
      if (this.hash) while (this.hashedTo < position && this.hashedTo < this.size) await this.load(this.hashedTo);
      if (!this.contains(position, length)) await this.load(position, length);
      if (!this.contains(position, length)) throw new Error('Unexpected EOF while reading ZIP');
    }
    return this.window.subarray(position - this.start, position - this.start + length);
  }

  /** Visit [position, position+length) as consecutive window views. */
  async forEachChunk(position: number, length: number, visit: (view: Buffer) => void | Promise<void>): Promise<void> {
    for (let done = 0; done < length;) {
      const len = Math.min(this.window.length, length - done);
      await visit(await this.slice(position + done, len));
      done += len;
    }
  }

  /** Hash every byte not yet covered by earlier reads. */
  async finishHash(): Promise<void> {
    if (!this.hash) return;
    while (this.hashedTo < this.size) await this.load(this.hashedTo);
  }
}

/** Payload start offset for an entry, read through a WindowedReader. */
async function payloadStartFromReader(reader: WindowedReader, e: ZipEntryInfo): Promise<number> {
  const header = await reader.slice(e.localOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL_SIG) {
    throw new Error(`Corrupt ZIP (bad local header for ${e.name})`);
  }
  return e.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
}

/** Sequential positional writer that coalesces small writes into large ones. */
class BufferedWriter {
  private readonly buf: Buffer;
  private used = 0;
  private flushed = 0;
  /** Logical end offset of everything written so far (flushed or buffered). */
  offset = 0;

  constructor(private readonly fh: fs.promises.FileHandle, private readonly label: string, sizeHint: number, private readonly hash?: ReturnType<typeof createHash>) {
    this.buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(MIN_WINDOW, sizeHint)));
  }

  private async writeAll(data: Buffer, position: number): Promise<void> {
    for (let off = 0; off < data.length;) {
      const { bytesWritten } = await this.fh.write(data, off, data.length - off, position + off);
      if (bytesWritten <= 0) throw new Error(`Could not write ZIP archive ${this.label}`);
      off += bytesWritten;
    }
  }

  async write(data: Buffer): Promise<void> {
    this.hash?.update(data);
    if (this.used + data.length > this.buf.length) await this.flush();
    if (data.length >= this.buf.length) {
      await this.writeAll(data, this.flushed);
      this.flushed += data.length;
    } else {
      data.copy(this.buf, this.used);
      this.used += data.length;
    }
    this.offset += data.length;
  }

  async flush(): Promise<void> {
    if (!this.used) return;
    await this.writeAll(this.buf.subarray(0, this.used), this.flushed);
    this.flushed += this.used;
    this.used = 0;
  }
}

/**
 * Rewrite `srcPath`, replacing (or appending) the entry `entryName` with `data`.
 * All other entries are copied byte-for-byte in their original order. The new
 * archive is written next to the source and atomically renamed over it.
 */
export async function rewriteZipEntry(srcPath: string, entryName: string, data: Buffer): Promise<void> {
  return archiveMutations.run([archiveResource(srcPath)], async () => { await rewriteZipEntryUnlocked(srcPath, entryName, data); });
}

interface RewriteVerifyResult {
  outFileHash: string;
  afterStat: fs.Stats;
}

async function rewriteZipEntryUnlocked(srcPath: string, entryName: string, data: Buffer | null, beforePublish?: () => Promise<void>, verifySource?: { expected: ArchiveSnapshot }): Promise<RewriteVerifyResult | undefined> {
  // Encode the replacement entry up front (deflate only when it saves space).
  const compressed = data === null ? Buffer.alloc(0) : await deflateRawAsync(data);
  const useDeflate = data !== null && compressed.length < data.length;
  const repMethod = useDeflate ? 8 : 0;
  const repCrc = data === null ? 0 : crc32(data);

  // A valid archive name can already use the filesystem's entire component
  // limit. Keep staging names independent of it, on the same filesystem for
  // atomic replacement.
  const tmpPath = path.join(path.dirname(srcPath), `.cbztmp-${randomUUID()}`);
  const src = await fs.promises.open(srcPath, 'r');
  const out = await fs.promises.open(tmpPath, 'wx').catch(async error => { await src.close(); throw error; });
  let written = false;
  let stat!: fs.Stats;
  let expectedOutSize = 0;
  const srcHash = verifySource ? createHash('sha256') : undefined;
  const outHash = verifySource ? createHash('sha256') : undefined;
  try {
    stat = await src.stat();
    if (verifySource) {
      const { expected } = verifySource;
      if (!stat.isFile() || stat.dev !== expected.device || stat.ino !== expected.inode || stat.size !== expected.size || stat.mtimeMs !== expected.mtimeMs) {
        throw new Error('Archive changed after preview; review required');
      }
    }
    const { entries, comment } = await readZipDirectoryFromDisk(src, stat.size, true);
    if (verifySource) {
      if (entries.filter((entry) => entry.name === 'ComicInfo.xml').length > 1) throw new Error('Duplicate ComicInfo.xml ZIP entries are ambiguous');
      const currentXml = await readComicInfoFromHandle(src, entries);
      if (currentXml !== verifySource.expected.xml) throw new Error('Archive changed after preview; review required');
    }
    // Entries are visited in archive order, so the read-ahead window and the
    // coalescing writer turn per-entry header/payload/descriptor syscalls
    // into roughly one large read and one large write per window.
    const reader = new WindowedReader(src, stat.size, srcHash);
    const writer = new BufferedWriter(out, srcPath, stat.size + (data?.length ?? 0), outHash);
    let centralSize = 0;
    const centrals: Buffer[] = [];

    for (const e of entries) {
      if (e.name === entryName) continue; // replaced by the new entry below
      const entryOffset = writer.offset;
      const start = await payloadStartFromReader(reader, e);
      // Keep names, flags, extra fields, attributes and entry comments verbatim.
      // Only the central record's local-header offset changes.
      const central = Buffer.from(e.centralRecord);
      central.writeUInt32LE(entryOffset, 42);
      await reader.forEachChunk(e.localOffset, start - e.localOffset, view => writer.write(view));
      // Stream the compressed payload through the read-ahead window.
      await reader.forEachChunk(start, e.compressedSize, view => writer.write(view));
      if (e.flags & 8) {
        const signed = (await reader.slice(start + e.compressedSize, 4)).readUInt32LE(0) === 0x08074b50;
        const descriptor = await reader.slice(start + e.compressedSize, signed ? 16 : 12);
        const base = signed ? 4 : 0;
        if (descriptor.readUInt32LE(base) !== e.crc || descriptor.readUInt32LE(base + 4) !== e.compressedSize || descriptor.readUInt32LE(base + 8) !== e.uncompressedSize) throw new Error('Corrupt ZIP (unsupported data descriptor)');
        await writer.write(descriptor);
      }
      centrals.push(central);
      centralSize += central.length;
    }

    // Replacement entry appended last — consumers (Kavita et al.) order pages
    // by file name, so position is cosmetic.
    if (data !== null) {
      const now = new Date();
      const repSpec: EntrySpec = {
        name: entryName,
        method: repMethod,
        crc: repCrc,
        compressedSize: (useDeflate ? compressed : data).length,
        uncompressedSize: data.length,
        offset: writer.offset,
        time: ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | (Math.floor(now.getSeconds() / 2) & 0x1f),
        date: (((Math.max(1980, now.getFullYear()) - 1980) & 0x7f) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
      };
      const repPayload = useDeflate ? compressed : data;
      const { local: repLocal, central: repCentral } = encodeHeaders(repSpec);
      await writer.write(repLocal);
      await writer.write(repPayload);
      centrals.push(repCentral);
      centralSize += repCentral.length;
    }

    const centralStart = writer.offset;
    const end = endOfCentralDirectory(centrals.length, centralStart, centralSize);
    end.writeUInt16LE(comment.length, 20);
    await writer.write(Buffer.concat([...centrals, end, comment]));
    await writer.flush();
    expectedOutSize = writer.offset;
    if (verifySource && srcHash) {
      await reader.finishHash();
      if (srcHash.digest('hex') !== verifySource.expected.fileHash) {
        throw new Error('Archive changed after preview; review required');
      }
    }
    written = true;
  } finally {
    await src.close();
    await out.close();
    if (!written) await fs.promises.rm(tmpPath, { force: true });
  }

  try {
    await beforePublish?.();
    if (verifySource) {
      const preRename = await fs.promises.stat(srcPath);
      const { expected } = verifySource;
      if (!preRename.isFile() || preRename.dev !== expected.device || preRename.ino !== expected.inode || preRename.size !== expected.size || preRename.mtimeMs !== expected.mtimeMs) {
        throw new Error('Archive changed after preview; review required');
      }
    }
    await fs.promises.rename(tmpPath, srcPath);
    invalidateCdCache(srcPath);
    if (verifySource && outHash) {
      const afterStat = await fs.promises.stat(srcPath);
      if (afterStat.size !== expectedOutSize) {
        throw new Error('ComicInfo exact restoration or unrelated archive content could not be verified');
      }
      return { outFileHash: outHash.digest('hex'), afterStat };
    }
    return undefined;
  } catch (error) {
    await fs.promises.rm(tmpPath, { force: true });
    throw error;
  }
}

export interface ArchiveSnapshot {
  xml: string | null;
  size: number;
  mtimeMs: number;
  hash: string;
  /** New snapshots bind the complete archive, not just its XML or timestamp. */
  fileHash: string;
  contentHash: string;
  device: number;
  inode: number;
}

async function readComicInfoFromHandle(fh: fs.promises.FileHandle, entries: ZipEntryInfo[]): Promise<string | null> {
  const e = entries.find((x) => x.name === 'ComicInfo.xml');
  if (!e) return null;
  if (e.compressedSize > 16*1024*1024 || e.uncompressedSize > 16*1024*1024) throw new Error('ComicInfo.xml exceeds the 16 MiB snapshot limit');
  const start = await payloadStartFromDisk(fh, e);
  const raw = Buffer.allocUnsafe(e.compressedSize);
  await readFull(fh, raw, start);
  switch (e.method) {
    case 0:
      return raw.toString('utf8');
    case 8:
      return (await inflateRawAsync(raw, { maxOutputLength: 16 * 1024 * 1024 })).toString('utf8');
    default:
      throw new Error(`Unsupported compression method ${e.method} for entry "ComicInfo.xml"`);
  }
}

/**
 * Fingerprint an archive: its exact bytes (fileHash), its non-ComicInfo entry
 * content (contentHash), and its ComicInfo.xml. One sequential pass over the
 * file feeds both hashes; a layout whose sorted entries are not in file order
 * costs extra reads for the out-of-order payloads, never a different result.
 */
export async function captureArchiveSnapshot(file: string): Promise<ArchiveSnapshot> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const before = await fh.stat();
    if (!before.isFile()) throw new Error('Archive is not a regular file');
    const hash = createHash('sha256');
    const content = createHash('sha256');
    const entries = await readZipEntriesFromDisk(fh, before.size, false);
    if (entries.filter(entry => entry.name === 'ComicInfo.xml').length > 1) throw new Error('Duplicate ComicInfo.xml ZIP entries are ambiguous');
    const reader = new WindowedReader(fh, before.size, hash);
    for (const entry of entries.filter(entry => entry.name !== 'ComicInfo.xml').sort((a,b) => NAME_COLLATOR.compare(a.name, b.name))) {
      content.update(JSON.stringify([entry.name,entry.method,entry.crc,entry.uncompressedSize,entry.compressedSize]));
      const start = await payloadStartFromReader(reader,entry);
      await reader.forEachChunk(start, entry.compressedSize, view => { content.update(view); });
    }
    await reader.finishHash();
    const xml = await readComicInfoFromHandle(fh, entries);
    const after = await fs.promises.stat(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('Archive changed while its fingerprint was being read; review required');
    }
    return {xml,size:before.size,mtimeMs:before.mtimeMs,hash:createHash('sha256').update(xml ?? '<absent>').digest('hex'),
      fileHash:hash.digest('hex'),contentHash:content.digest('hex'),device:before.dev,inode:before.ino};
  } finally { await fh.close(); }
}

export function sameArchiveSnapshot(expected: ArchiveSnapshot, current: ArchiveSnapshot): boolean {
  return expected.fileHash === current.fileHash && expected.size === current.size && expected.mtimeMs === current.mtimeMs
    && expected.device === current.device && expected.inode === current.inode && expected.xml === current.xml;
}

/**
 * Exactly what sameArchiveSnapshot(expected, await captureArchiveSnapshot(file))
 * decides, without the content-identity pass: identity/size/mtime are checked
 * before any hashing, then the complete file bytes and ComicInfo.xml. An equal
 * fileHash means byte-identical content, so contentHash cannot differ either.
 */
export async function verifyArchiveSnapshot(file: string, expected: ArchiveSnapshot): Promise<boolean> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const before = await fh.stat();
    if (!before.isFile()) throw new Error('Archive is not a regular file');
    if (before.dev !== expected.device || before.ino !== expected.inode || before.size !== expected.size || before.mtimeMs !== expected.mtimeMs) return false;
    const xml = await readComicInfoFromHandle(fh, await readZipEntriesFromDisk(fh, before.size, false));
    if (xml !== expected.xml) return false;
    const hash = createHash('sha256');
    const reader = new WindowedReader(fh, before.size, hash);
    await reader.finishHash();
    if (hash.digest('hex') !== expected.fileHash) return false;
    const after = await fs.promises.stat(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('Archive changed while its fingerprint was being read; review required');
    }
    return true;
  } finally { await fh.close(); }
}

/** Caller owns archive mutation resources. Verify the approved file again before atomic publication. */
export async function restoreComicInfoArchive(file: string, xml: string | null, expected: ArchiveSnapshot): Promise<ArchiveSnapshot> {
  if (xml === expected.xml) {
    // Nothing to write: one full capture both verifies and observes.
    const after = await captureArchiveSnapshot(file);
    if (!sameArchiveSnapshot(expected,after)) throw new Error('Archive changed after preview; review required');
    if (after.contentHash !== expected.contentHash) throw new Error('ComicInfo exact restoration or unrelated archive content could not be verified');
    return after;
  }
  const verified = await rewriteZipEntryUnlocked(file, 'ComicInfo.xml', xml === null ? null : Buffer.from(xml, 'utf8'), undefined, { expected });
  if (!verified) throw new Error('ComicInfo exact restoration or unrelated archive content could not be verified');
  return {
    xml,
    size: verified.afterStat.size,
    mtimeMs: verified.afterStat.mtimeMs,
    hash: createHash('sha256').update(xml ?? '<absent>').digest('hex'),
    fileHash: verified.outFileHash,
    contentHash: expected.contentHash,
    device: verified.afterStat.dev,
    inode: verified.afterStat.ino,
  };
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
    const entries = await readCachedZipEntriesFromDisk(p, fh, stat);
    return await readComicInfoFromHandle(fh, entries);
  } finally {
    await fh.close();
  }
}

/** Single-open helper for duplicate scanning: reads ComicInfo.xml and counts image entries in one central-directory parse. */
export async function readComicInfoAndImageCount(p: string): Promise<{ xml: string | null; imageCount: number }> {
  const fh = await fs.promises.open(p, 'r');
  try {
    const stat = await fh.stat();
    const entries = await readCachedZipEntriesFromDisk(p, fh, stat);
    const xml = await readComicInfoFromHandle(fh, entries);
    let imageCount = 0;
    for (const e of entries) if (imageMime(e.name) !== null) imageCount++;
    return { xml, imageCount };
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

/** One collator for natural page order; localeCompare would rebuild it per comparison. */
const PAGE_NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Compare page file names in natural order (02.jpg before 10.jpg). */
function comparePageNames(a: string, b: string): number {
  return PAGE_NAME_COLLATOR.compare(a, b);
}

/**
 * Image entries of a CBZ in reading order. Positional read: only the central
 * directory is touched, never the payloads.
 */
export async function listCbzImages(p: string): Promise<string[]> {
  const fh = await fs.promises.open(p, 'r');
  try {
    const stat = await fh.stat();
    const entries = await readCachedZipEntriesFromDisk(p, fh, stat);
    return entries.map((e) => e.name).filter((name) => imageMime(name) !== null).sort(comparePageNames);
  } finally {
    await fh.close();
  }
}

/** Hard cap on a cover payload (a single page image, never the whole archive). */
const COVER_MAX_BYTES = 32 * 1024 * 1024;
/** Hard cap on any single entry read for serving (one page image). */
const ENTRY_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Reject an entry whose declared payload exceeds the cap or runs past the end
 * of the file. Central-directory sizes are untrusted: a corrupt or hostile
 * archive could otherwise force a multi-GiB allocation.
 */
function checkPayloadBounds(e: ZipEntryInfo, start: number, fileSize: number, maxBytes: number): void {
  if (e.compressedSize > maxBytes || e.uncompressedSize > maxBytes) throw new Error(`Entry "${e.name}" exceeds the ${Math.round(maxBytes / (1024 * 1024))} MiB limit`);
  if (start + e.compressedSize > fileSize) throw new Error(`Corrupt ZIP (entry "${e.name}" extends past end of file)`);
}

/**
 * Read one CBZ entry as raw bytes. Positional read: only the central directory
 * and this entry's payload are touched, never the whole archive.
 */
export async function readZipEntryFromDisk(p: string, entryName: string, maxBytes = ENTRY_MAX_BYTES): Promise<Buffer> {
  const fh = await fs.promises.open(p, 'r');
  try {
    const stat = await fh.stat();
    const entries = await readCachedZipEntriesFromDisk(p, fh, stat);
    const e = entries.find((x) => x.name === entryName);
    if (!e) throw new Error(`Entry "${entryName}" not found`);
    const start = await payloadStartFromDisk(fh, e);
    // Sizes come from the archive itself: bound them before allocating.
    checkPayloadBounds(e, start, stat.size, maxBytes);
    const raw = Buffer.allocUnsafe(e.compressedSize);
    await readFull(fh, raw, start);
    switch (e.method) {
      case 0:
        return raw;
      case 8:
        return await inflateRawAsync(raw, { maxOutputLength: maxBytes });
      default:
        throw new Error(`Unsupported compression method ${e.method} for entry "${entryName}"`);
    }
  } finally {
    await fh.close();
  }
}


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
    const image = [...names].sort(comparePageNames).find((n) => imageMime(n) !== null);
    if (!image) return null;
    try {
      const data = await fs.promises.readFile(path.join(outputPath, image));
      if (data.length === 0 || data.length > COVER_MAX_BYTES) return null;
      return { data, mime: imageMime(image)! };
    } catch {
      return null;
    }
  }

  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(outputPath, 'r');
  } catch {
    return null;
  }
  try {
    const entries = await readZipEntriesFromDisk(fh, st.size);
    const imageEntries = entries
      .filter((e) => imageMime(e.name) !== null && (e.method === 0 || e.method === 8) && e.uncompressedSize > 0 && e.uncompressedSize <= COVER_MAX_BYTES)
      .sort((a, b) => comparePageNames(a.name, b.name));
    for (const e of imageEntries) {
      const mime = imageMime(e.name)!;
      let data: Buffer;
      try {
        const start = await payloadStartFromDisk(fh, e);
        checkPayloadBounds(e, start, st.size, COVER_MAX_BYTES);
        const raw = Buffer.allocUnsafe(e.compressedSize);
        await readFull(fh, raw, start);
        // The declared size is untrusted; cap what inflate may produce.
        data = e.method === 0 ? raw : await inflateRawAsync(raw, { maxOutputLength: COVER_MAX_BYTES });
      } catch {
        continue; // one bad entry must not hide a later valid cover
      }
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

/** Async resolveExistingFile for request paths: a network-drive stat never blocks the event loop. */
export async function resolveExistingFileAsync(p: string): Promise<string | null> {
  if (!p || !path.isAbsolute(p)) return null;
  const full = path.resolve(p);
  try {
    return (await fs.promises.stat(full)).isFile() ? full : null;
  } catch {
    return null;
  }
}

/** Async listCbzFiles: same traversal, depth bound and ordering, without blocking readdir calls. */
export async function listCbzFilesAsync(dir: string, maxDepth = 3): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < maxDepth) await walk(path.join(d, e.name), depth + 1);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.cbz')) {
        out.push(path.join(d, e.name));
      }
    }
  };
  await walk(dir, 0);
  return out.sort((a, b) => a.localeCompare(b));
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
  onMoved?: (source: string, destination: string) => void,
  signal?: AbortSignal,
  beforePublish?: (source: string, destination: string) => Promise<void>,
): Promise<MergeCbzOutcome> {
  if (!path.isAbsolute(targetDir)) throw new Error('targetDir must be an absolute path');
  const out: MergeCbzOutcome = { moved: [], skipped: [], chaptered: [], failed: [] };
  await fs.promises.mkdir(targetDir, { recursive: true });
  const targetResource = await archiveResourceAsync(targetDir);
  const pathExists = (p: string) => fs.promises.access(p).then(() => true, () => false);

  const seen = new Set<string>();
  for (const src of sourceFiles) {
    if (seen.has(src)) continue;
    seen.add(src);
    try {
      await archiveMutations.run([await archiveResourceAsync(src), targetResource], async () => {
        const file = await resolveExistingFileAsync(src);
        if (!file) throw new Error('file not found');
        if (!file.toLowerCase().endsWith('.cbz')) throw new Error('not a .cbz file');

        // Move into the target (or keep in place), resolving name collisions.
        let dest = path.join(targetDir, path.basename(file));
        const alreadyThere = path.resolve(dest) === path.resolve(file);
        if (!alreadyThere && await pathExists(dest)) {
          const ext = path.extname(file);
          const stem = path.basename(file, ext);
          for (let n = 2; ; n++) {
            const candidate = path.join(targetDir, `${stem} (${n})${ext}`);
            if (!(await pathExists(candidate))) {
              dest = candidate;
              break;
            }
          }
        }
        // The caller's authoritative guard runs inside this archive ownership,
        // immediately before either moving or stamping the archive.
        await beforePublish?.(file, dest);
        if (!alreadyThere) {
          await moveFileAcross(file, dest);
          await removeEmptiedSourceDir(file, targetDir);
        }
        out.moved.push(dest);
        onMoved?.(src, dest);

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
          if (Object.keys(fields).length > 0) await setComicInfoFieldsUnlocked(dest, fields, existing);
          if (wantNumber) out.chaptered.push(dest);
        }
      }, signal);
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      out.failed.push({ file: src, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/**
 * Remove `file`'s parent folder if a move just left it empty. rmdir throws
 * ENOTEMPTY on non-empty folders, so anything still holding content — or the
 * target itself — survives untouched.
 */
async function removeEmptiedSourceDir(file: string, targetDir: string): Promise<void> {
  const dir = path.dirname(file);
  if (path.resolve(dir) === path.resolve(targetDir)) return;
  await fs.promises.rmdir(dir).catch(() => { /* non-empty or in use — keep it */ });
}

/** rename with a copy+delete fallback for cross-device moves. */
async function moveFileAcross(src: string, dest: string): Promise<void> {
  try {
    await fs.promises.rename(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    const staging = path.join(path.dirname(dest),`.cbzmerge-${randomUUID()}.tmp`);
    let failed = false;
    let primaryError: unknown;
    try {
      await fs.promises.copyFile(src, staging);
      await fs.promises.rename(staging, dest);
      await fs.promises.unlink(src);
    } catch (error) {
      failed = true;
      primaryError = error;
    }
    try {
      await fs.promises.unlink(staging);
    } catch (error) {
      if (!failed && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (failed) throw primaryError;
  }
}

/** Write the given ComicInfo fields into a CBZ, preserving the other fields of any existing entry. */
export function setComicInfoFields(file: string, fields: Record<string, string>, beforeWrite?: () => Promise<void>): Promise<void> {
  return archiveMutations.run([archiveResource(file)], async () => {
    await beforeWrite?.();
    return setComicInfoFieldsUnlocked(file, fields);
  });
}

async function setComicInfoFieldsUnlocked(file: string, fields: Record<string, string>, existingXml?: string | null): Promise<void> {
  const existing = existingXml !== undefined ? existingXml : await readComicInfo(file);
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
  await rewriteZipEntryUnlocked(file, 'ComicInfo.xml', Buffer.from(xml, 'utf8'));
}

export interface SeriesTitleRewriteResult {
  changed: number;
  verified: number;
}

/** Rewrite ComicInfo.Series across every CBZ, restoring earlier archives if any rewrite or verification fails. */
export async function setSeriesTitleInCbzFiles(files: string[], seriesTitle: string, signal?: AbortSignal): Promise<SeriesTitleRewriteResult> {
  if (!files.length) return { changed: 0, verified: 0 };
  const resources = await mapLimit(files, 16, archiveResourceAsync);
  return archiveMutations.run(resources, () => rewriteSeriesTitles(files, seriesTitle), signal);
}

async function rewriteSeriesTitles(files: string[], seriesTitle: string): Promise<SeriesTitleRewriteResult> {
  const originals = new Map<string, string | null>();
  for (const file of files) originals.set(file, await readComicInfo(file));

  const changed: string[] = [];
  try {
    for (const file of files) {
      const existing = originals.get(file);
      if (!existing || parseComicInfo(existing).fields.Series?.trim() !== seriesTitle) {
        await setComicInfoFieldsUnlocked(file, { Series: seriesTitle }, existing);
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
        await rewriteZipEntryUnlocked(file, 'ComicInfo.xml', Buffer.from(original, 'utf8'));
      }
    }
    throw error;
  }
  return { changed: changed.length, verified: files.length };
}


/** Read, merge and publish one complete editor action under the same archive ownership. */
export function editComicInfo(file: string, edit: { xml?: string; fields?: Record<string, string> }, signal?: AbortSignal): Promise<{ previousSeriesName?: string; xml: string }> {
  return archiveMutations.run([archiveResource(file)], async () => {
    const existing = await readComicInfo(file);
    const doc = existing ? parseComicInfo(existing) : { order: [], fields: {}, rawInner: {} };
    const xml = edit.xml?.trim() ? edit.xml : renderComicInfoXml({ values: { ...doc.fields, ...edit.fields }, order: doc.order, rawInner: doc.rawInner, edited: Object.keys(edit.fields ?? {}) });
    await rewriteZipEntryUnlocked(file, 'ComicInfo.xml', Buffer.from(xml, 'utf8'));
    return { previousSeriesName: doc.fields.Series?.trim(), xml };
  }, signal);
}

/** Stream exact archive identity without buffering the whole CBZ in memory. */
export async function hashArchiveFile(file:string,signal?:AbortSignal):Promise<string> {
  const hash=createHash('sha256');
  for await (const chunk of fs.createReadStream(file,{signal}) as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest('hex');
}
