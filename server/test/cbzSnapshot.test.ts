import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { captureArchiveSnapshot, readZipEntries, readZipEntry, rewriteZipEntry, verifyArchiveSnapshot } from '../src/lib/cbz.js';
import { buildZip, buildZipFromFiles } from '../src/downloader/zip.js';

const dir = fs.mkdtempSync(path.join(tmpdir(), 'htosho-cbz-snapshot-'));

/** Reference fingerprint: the original two-pass definition, computed from an in-memory copy. */
function referenceHashes(file: string): { fileHash: string; contentHash: string } {
  const buf = fs.readFileSync(file);
  const content = createHash('sha256');
  for (const entry of readZipEntries(buf).filter(e => e.name !== 'ComicInfo.xml').sort((a, b) => a.name.localeCompare(b.name))) {
    content.update(JSON.stringify([entry.name, entry.method, entry.crc, entry.uncompressedSize, entry.compressedSize]));
    const start = entry.localOffset + 30 + buf.readUInt16LE(entry.localOffset + 26) + buf.readUInt16LE(entry.localOffset + 28);
    content.update(buf.subarray(start, start + entry.compressedSize));
  }
  return { fileHash: createHash('sha256').update(buf).digest('hex'), contentHash: content.digest('hex') };
}

// Pages span several 8 MiB read-ahead windows, including one larger than a window.
const pages: Record<string, Buffer> = {
  '001.jpg': randomBytes(300 * 1024),
  '002.jpg': randomBytes(9 * 1024 * 1024),
  '003.jpg': randomBytes(5 * 1024 * 1024),
  '004.txt': Buffer.alloc(200 * 1024, 'compressible text '),
  '005.jpg': Buffer.alloc(0),
};
const comicInfo = Buffer.from('<?xml version="1.0"?>\n<ComicInfo><Series>Before</Series></ComicInfo>\n');

async function buildFromFiles(name: string, order: string[]): Promise<string> {
  const pageDir = fs.mkdtempSync(path.join(dir, 'pages-'));
  const files = order.map(page => { const p = path.join(pageDir, page); fs.writeFileSync(p, pages[page]); return { name: page, path: p }; });
  const out = path.join(dir, name);
  await buildZipFromFiles(files, out, [{ name: 'ComicInfo.xml', data: comicInfo }]);
  return out;
}

test('streaming writer output round-trips every entry', async () => {
  const file = await buildFromFiles('written.cbz', Object.keys(pages));
  const buf = fs.readFileSync(file);
  assert.deepEqual(readZipEntries(buf).map(e => e.name), [...Object.keys(pages), 'ComicInfo.xml']);
  for (const [name, data] of Object.entries(pages)) assert.ok(readZipEntry(buf, name)!.equals(data), name);
  assert.ok(readZipEntry(buf, 'ComicInfo.xml')!.equals(comicInfo));
});

test('single-pass capture matches the reference fingerprint for in-order and out-of-order layouts', async () => {
  for (const [name, order] of [['ordered.cbz', Object.keys(pages)], ['reversed.cbz', Object.keys(pages).reverse()]] as const) {
    const file = await buildFromFiles(name, [...order]);
    const snapshot = await captureArchiveSnapshot(file);
    assert.deepEqual({ fileHash: snapshot.fileHash, contentHash: snapshot.contentHash }, referenceHashes(file), name);
    assert.equal(snapshot.xml, comicInfo.toString('utf8'));
    assert.equal(await verifyArchiveSnapshot(file, snapshot), true);
  }
});

test('capture of a small in-memory archive matches the reference fingerprint', async () => {
  const file = path.join(dir, 'small.cbz');
  fs.writeFileSync(file, buildZip([{ name: 'b.jpg', data: Buffer.from('bb') }, { name: 'a.jpg', data: Buffer.from('a') }]));
  const snapshot = await captureArchiveSnapshot(file);
  assert.deepEqual({ fileHash: snapshot.fileHash, contentHash: snapshot.contentHash }, referenceHashes(file));
  assert.equal(snapshot.xml, null);
});

test('rewrite through the read-ahead window preserves every other entry and content identity', async () => {
  const file = await buildFromFiles('rewrite.cbz', Object.keys(pages));
  const before = await captureArchiveSnapshot(file);
  const replacement = Buffer.from('<?xml version="1.0"?>\n<ComicInfo><Series>After</Series></ComicInfo>\n');
  await rewriteZipEntry(file, 'ComicInfo.xml', replacement);
  const buf = fs.readFileSync(file);
  for (const [name, data] of Object.entries(pages)) assert.ok(readZipEntry(buf, name)!.equals(data), name);
  assert.ok(readZipEntry(buf, 'ComicInfo.xml')!.equals(replacement));
  const after = await captureArchiveSnapshot(file);
  assert.equal(after.contentHash, before.contentHash);
  assert.deepEqual({ fileHash: after.fileHash, contentHash: after.contentHash }, referenceHashes(file));
  assert.equal(await verifyArchiveSnapshot(file, before), false);
});

test('verification rejects same-size byte changes and XML changes', async () => {
  const file = await buildFromFiles('verify.cbz', Object.keys(pages));
  const snapshot = await captureArchiveSnapshot(file);
  assert.equal(await verifyArchiveSnapshot(file, { ...snapshot, xml: 'other' }), false);
  const buf = fs.readFileSync(file);
  buf[400 * 1024] ^= 0xff; // inside 002.jpg's stored payload
  fs.writeFileSync(file, buf);
  const stat = fs.statSync(file);
  // Same identity and timestamps: only the content hash can tell.
  assert.equal(await verifyArchiveSnapshot(file, { ...snapshot, mtimeMs: stat.mtimeMs, device: stat.dev, inode: stat.ino }), false);
});

test('truncated archives fail capture instead of producing a fingerprint', async () => {
  const file = await buildFromFiles('truncated.cbz', Object.keys(pages));
  const buf = fs.readFileSync(file);
  const entries = readZipEntries(buf);
  // Point an entry's payload past the end of the file by shrinking the data region.
  const big = entries.find(e => e.name === '002.jpg')!;
  const broken = Buffer.concat([buf.subarray(0, big.localOffset + 1000), buf.subarray(buf.length - (buf.length - entries.at(-1)!.localOffset))]);
  fs.writeFileSync(file, broken);
  await assert.rejects(captureArchiveSnapshot(file));
});
