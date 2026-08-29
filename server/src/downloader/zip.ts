import { deflateRawSync } from 'node:zlib';
import fs from 'node:fs';
import { crc32 } from '../lib/crc.js';

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

function encodeEntry(
  name: string,
  data: Buffer,
  offset: number,
  now: { time: number; date: number },
  tryDeflate: boolean,
): EncodedEntry {
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data);
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
 * Stream a ZIP archive to `destPath` from page files on disk. Each file is
 * read one at a time (peak memory = one image), so multi-hundred-MB galleries
 * no longer need ~2x their size in RAM. Entries are written in the given
 * order; small in-memory entries (e.g. ComicInfo.xml) can be appended after
 * the file-based ones. On failure the partial archive is removed before
 * rethrowing.
 */
export async function buildZipFromFiles(
  files: { name: string; path: string }[],
  destPath: string,
  inlineEntries: Entry[] = [],
): Promise<void> {
  // Promise.withResolvers is unavailable on the ES2022 target, so capture the
  // resolvers explicitly.
  let resolveDone!: () => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const out = fs.createWriteStream(destPath);
  out.on('error', (e) => rejectDone(e));
  out.on('finish', () => resolveDone());

  // Respect the WriteStream's backpressure: buffering the whole archive
  // in-memory when the destination (NAS, SMR disk) stalls defeats the
  // one-image peak-memory design.
  const write = async (buf: Buffer): Promise<void> => {
    if (!out.write(buf)) await new Promise<void>((resolve) => out.once('drain', resolve));
  };

  try {
    let offset = 0;
    const central: Buffer[] = [];
    const now = dosDateTime(new Date());
    const append = async (name: string, data: Buffer, tryDeflate: boolean): Promise<void> => {
      const spec = encodeEntry(name, data, offset, now, tryDeflate);
      await write(spec.local);
      await write(spec.payload);
      central.push(spec.central);
      offset += spec.local.length + spec.payload.length;
    };

    for (const f of files) {
      const ext = f.name.slice(f.name.lastIndexOf('.') + 1).toLowerCase();
      await append(f.name, await fs.promises.readFile(f.path), !STORE_EXTENSIONS[ext]);
    }
    for (const e of inlineEntries) {
      await append(e.name, e.data, true);
    }

    const centralStart = offset;
    let centralSize = 0;
    for (const c of central) centralSize += c.length;
    for (const c of central) await write(c);
    await write(endOfCentralDirectory(files.length + inlineEntries.length, centralStart, centralSize));
    out.end();
  } catch (e) {
    out.destroy();
    rejectDone(e instanceof Error ? e : new Error(String(e)));
  }

  let ok = false;
  try {
    await done;
    ok = true;
  } finally {
    // Never leave a partial archive behind on failure.
    if (!ok) fs.rmSync(destPath, { force: true });
  }
}
