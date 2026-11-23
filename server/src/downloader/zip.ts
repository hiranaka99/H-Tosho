import { deflateRaw, deflateRawSync } from 'node:zlib';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from '../lib/crc.js';

const deflateRawAsync = promisify(deflateRaw);
const MAX_ZIP32_ENTRIES = 0xffff;
const MAX_ZIP32_OFFSET = 0xffffffff;

/**
 * Minimal, dependency-free ZIP (CBZ) writer.
 *
 * Uses DEFLATE compression (method 8) where it actually saves space — XML and
 * other text — while already-compressed image payloads are stored (method 0),
 * so galleries stay small on disk while remaining fully readable by Kavita and
 * any other CBZ consumer. All entries are written in "local file header +
 * central directory" order per the PKZIP spec. Offsets are computed as we
 * append, then the central directory and End-Of-Central-Directory record are
 * finalized at the end.
 *
 * Two entry points: `buildZip` (in-memory, for small payloads) and
 * `buildZipFromFiles`, which streams page data from disk files one at a time
 * so large galleries never hold more than one image in memory.
 */

interface Entry {
  name: string; // UTF-8 entry path (no leading slash)
  data: Buffer;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const d = (((year - 1980) & 0x7f) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: d };
}

/** One encoded entry: local header (incl. name), payload, central record (incl. name). */
interface EncodedEntry {
  local: Buffer;
  payload: Buffer;
  central: Buffer;
}

function encodeEntryWithPayload(
  name: string,
  data: Buffer,
  payload: Buffer,
  method: number,
  offset: number,
  now: { time: number; date: number },
): EncodedEntry {
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  if (offset > MAX_ZIP32_OFFSET || payload.length > MAX_ZIP32_OFFSET || data.length > MAX_ZIP32_OFFSET) {
    throw new Error('Archive exceeds the 4 GiB CBZ limit; use Image folder format for galleries this large.');
  }

  // Local file header (30 bytes + name).
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0); // signature
  local.writeUInt16LE(20, 4); // version needed to extract
  local.writeUInt16LE(0x0800, 6); // general purpose flags: UTF-8 name
  local.writeUInt16LE(method, 8); // compression method
  local.writeUInt16LE(now.time, 10);
  local.writeUInt16LE(now.date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18); // compressed size
  local.writeUInt32LE(data.length, 22); // uncompressed size
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra field length
  nameBuf.copy(local, 30);

  // Central directory record (46 bytes + name).
  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0); // signature
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed to extract
  central.writeUInt16LE(0x0800, 8); // flags: UTF-8 name
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(now.time, 12);
  central.writeUInt16LE(now.date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30); // extra field length
  central.writeUInt16LE(0, 32); // comment length
  central.writeUInt16LE(0, 34); // disk number start
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(offset, 42); // local header offset
  nameBuf.copy(central, 46);

  return { local, payload, central };
}

function encodeEntry(
  name: string,
  data: Buffer,
  offset: number,
  now: { time: number; date: number },
  tryDeflate: boolean,
): EncodedEntry {
  // Prefer deflate only when it actually saves space; otherwise store.
  // Already-compressed payloads skip the deflate attempt entirely: it costs
  // full-zlib CPU synchronously on the event loop and saves <2% on JPEG/WebP.
  let method = 0;
  let payload = data;
  if (tryDeflate) {
    const compressed = deflateRawSync(data);
    if (compressed.length < data.length) {
      method = 8;
      payload = compressed;
    }
  }
  return encodeEntryWithPayload(name, data, payload, method, offset, now);
}

async function encodeEntryAsync(
  name: string,
  data: Buffer,
  offset: number,
  now: { time: number; date: number },
  tryDeflate: boolean,
): Promise<EncodedEntry> {
  let method = 0;
  let payload = data;
  if (tryDeflate) {
    const compressed = await deflateRawAsync(data);
    if (compressed.length < data.length) {
      method = 8;
      payload = compressed;
    }
  }
  return encodeEntryWithPayload(name, data, payload, method, offset, now);
}

/** File extensions whose payload is already compressed — stored, never deflated. */
const STORE_EXTENSIONS: Record<string, true> = {
  jpg: true,
  jpeg: true,
  png: true,
  webp: true,
  avif: true,
  gif: true,
  jxl: true,
  heic: true,
  heif: true,
};

function endOfCentralDirectory(count: number, centralStart: number, centralSize: number): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(count, 8); // entries on this disk
  eocd.writeUInt16LE(count, 10); // total entries
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  return eocd;
}

/** Build a ZIP archive (Buffer) from the given named entries. */
export function buildZip(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const now = dosDateTime(new Date());

  for (const entry of entries) {
    const spec = encodeEntry(entry.name, entry.data, offset, now, true);
    parts.push(spec.local, spec.payload);
    central.push(spec.central);
    offset += spec.local.length + spec.payload.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const b of central) centralSize += b.length;

  return Buffer.concat([...parts, ...central, endOfCentralDirectory(entries.length, centralStart, centralSize)]);
}

/**
 * Build a ZIP archive at `destPath` from page files on disk. Each file is read
 * one at a time (peak memory = one image), and positional file-handle writes
 * avoid stream backpressure/error races. Only a complete archive replaces the destination.
 */
export async function buildZipFromFiles(
  files: { name: string; path: string }[],
  destPath: string,
  inlineEntries: Entry[] = [],
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const totalEntries = files.length + inlineEntries.length;
  if (totalEntries > MAX_ZIP32_ENTRIES) {
    throw new Error('Archive exceeds the 65,535-entry CBZ limit; use Image folder format for galleries this large.');
  }
  const stagingDir = await fs.promises.mkdtemp(path.join(path.dirname(destPath), '.htosho-zip-'));
  const stagingPath = path.join(stagingDir, 'archive.cbz');
  let out: fs.promises.FileHandle;
  try {
    out = await fs.promises.open(stagingPath, 'wx');
  } catch (error) {
    await fs.promises.rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
  let failure: unknown;
  try {
    let offset = 0;
    const central: Buffer[] = [];
    const now = dosDateTime(new Date());
    const write = async (buf: Buffer): Promise<void> => {
      let written = 0;
      while (written < buf.length) {
        const result = await out.write(buf, written, buf.length - written, offset + written);
        if (result.bytesWritten <= 0) throw new Error(`Could not write ZIP archive ${destPath}`);
        written += result.bytesWritten;
      }
      offset += buf.length;
    };
    const append = async (name: string, data: Buffer, tryDeflate: boolean): Promise<void> => {
      signal?.throwIfAborted();
      const entryOffset = offset;
      const spec = await encodeEntryAsync(name, data, entryOffset, now, tryDeflate);
      await write(spec.local);
      await write(spec.payload);
      central.push(spec.central);
    };

    for (const f of files) {
      signal?.throwIfAborted();
      const ext = f.name.slice(f.name.lastIndexOf('.') + 1).toLowerCase();
      await append(f.name, await fs.promises.readFile(f.path), !STORE_EXTENSIONS[ext]);
    }
    for (const e of inlineEntries) await append(e.name, e.data, true);

    signal?.throwIfAborted();
    const centralStart = offset;
    let centralSize = 0;
    for (const c of central) centralSize += c.length;
    if (centralStart > MAX_ZIP32_OFFSET || centralSize > MAX_ZIP32_OFFSET) {
      throw new Error('Archive exceeds the 4 GiB CBZ limit; use Image folder format for galleries this large.');
    }
    await write(Buffer.concat([...central, endOfCentralDirectory(totalEntries, centralStart, centralSize)]));
  } catch (error) {
    failure = error;
  }
  try {
    await out.close();
  } catch (error) {
    failure ??= error;
  }
  try {
    if (failure !== undefined) throw failure;
    signal?.throwIfAborted();
    await fs.promises.rename(stagingPath, destPath);
  } finally {
    await fs.promises.rm(stagingDir, { recursive: true, force: true });
  }
}
