import * as zlib from 'node:zlib';

/**
 * Shared CRC-32 (IEEE 802.3, the ZIP polynomial). Used by the CBZ writer
 * (downloader/zip.ts) and the CBZ reader/rewriter (lib/cbz.ts).
 *
 * Node >= 20.15 / 22.2 ship a native implementation which is ~10x faster than
 * the table-driven JS loop; the JS fallback keeps older 20.x runtimes working.
 */

let table: number[] | null = null;
function crcTable(): number[] {
  if (table) return table;
  table = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
}

function jsCrc32(buf: Buffer): number {
  const t = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = t[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const native = zlib as unknown as { crc32?: (buf: Buffer) => number };

export function crc32(buf: Buffer): number {
  return typeof native.crc32 === 'function' ? native.crc32(buf) : jsCrc32(buf);
}
