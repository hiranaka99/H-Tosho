import assert from 'node:assert/strict';
import fs, { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, it } from 'node:test';

import { pathContains, readCoverImage, readZipEntries, readZipEntry, rewriteZipEntry, mergeCbzFiles, resolveSeriesHostDir } from '../src/lib/cbz.js';
import { buildZip, buildZipFromFiles } from '../src/downloader/zip.js';
import { parseComicInfo, renderComicInfoXml } from '../src/downloader/comicinfo.js';

const dir = mkdtempSync(path.join(tmpdir(), 'htosho-cbz-'));
const cbzPath = path.join(dir, 'sample.cbz');

/** A few realistic-looking entries: compressible text, incompressible bytes, and the metadata file. */
function makeSampleArchive(): { entries: Record<string, Buffer> } {
  const pages = Array.from({ length: 5 }, (_, i) => Buffer.alloc(64 * 1024, (i * 37 + 1) & 0xff)); // stored (incompressible)
  const comicInfo = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?>\n<ComicInfo>\n  <Title><![CDATA[Sample Gallery]]></Title>\n</ComicInfo>\n',
    'utf8',
  ); // deflated (compressible)
  const entries: Record<string, Buffer> = {
    '001.jpg': pages[0],
    '002.jpg': pages[1],
    '003.jpg': pages[2],
    '004.jpg': pages[3],
    '005.jpg': pages[4],
    'ComicInfo.xml': comicInfo,
  };
  writeFileSync(
    cbzPath,
    buildZip(Object.entries(entries).map(([name, data]) => ({ name, data }))),
  );
  return { entries };
}

describe('pathContains', () => {
  it('accepts descendants but rejects sibling paths with a shared prefix', () => {
    assert.equal(pathContains('/media/manga', '/media/manga/title/book.cbz'), true);
    assert.equal(pathContains('/media/manga', '/media/manga-archive/title/book.cbz'), false);
    assert.equal(pathContains('C:\\Manga', 'C:\\Manga\\Title\\book.cbz'), true);
  });
});

describe('file-based archive replacement', () => {
  it('preserves the previous archive on packing failure and replaces it on success', async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'htosho-zip-replace-'));
    try {
      const destination = path.join(fixture, 'existing.cbz');
      const previous = buildZip([{ name: '001.jpg', data: Buffer.from('old image') }]);
      writeFileSync(destination, previous);
      await assert.rejects(buildZipFromFiles([{ name: '001.jpg', path: path.join(fixture, 'missing') }], destination), { code: 'ENOENT' });
      assert.deepEqual(readFileSync(destination), previous);
      const page = path.join(fixture, 'page');
      writeFileSync(page, 'replacement image');
      await buildZipFromFiles([{ name: '001.jpg', path: page }], destination);
      assert.equal(readZipEntry(readFileSync(destination), '001.jpg')?.toString(), 'replacement image');
      assert.deepEqual(readdirSync(fixture).sort(), ['existing.cbz', 'page']);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});

/**
 * Hand-crafted archive emulating a foreign tool: stored entry with a non-empty
 * extra field in BOTH the local header and the central directory record. Our
 * own writer never emits extra fields, so this exercises the reader's offset
 * math against headers it did not produce.
 */
function makeForeignArchive(p: string): void {
  const name = Buffer.from('a.txt', 'utf8');
  const data = Buffer.from('foreign content', 'utf8');
  const extra = Buffer.from([0x00, 0x01, 0xaa, 0xbb]);
  const crc = crc32(data) >>> 0;

  const local = Buffer.alloc(30 + name.length + extra.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6); // no flags
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(extra.length, 28);
  name.copy(local, 30);
  extra.copy(local, 30 + name.length);

  const central = Buffer.alloc(46 + name.length + extra.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(extra.length, 30);
  central.writeUInt32LE(0, 42); // local offset
  name.copy(central, 46);
  extra.copy(central, 46 + name.length);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + data.length, 16);

  writeFileSync(p, Buffer.concat([local, data, central, eocd]));
}

describe('cbz zip reader', () => {
  it('reads entries and contents from our own writer', () => {
    const { entries } = makeSampleArchive();
    const buf = readFileSync(cbzPath);
    const list = readZipEntries(buf);
    assert.deepEqual(
      list.map((e) => e.name),
      ['001.jpg', '002.jpg', '003.jpg', '004.jpg', '005.jpg', 'ComicInfo.xml'],
    );
    for (const [name, data] of Object.entries(entries)) {
      assert.ok(readZipEntry(buf, name)?.equals(data), `entry ${name} round-trips`);
    }
    assert.equal(readZipEntry(buf, 'missing.jpg'), null);
  });

  it('reads archives with local-header extra fields (foreign tools)', () => {
    const foreign = path.join(dir, 'foreign.cbz');
    makeForeignArchive(foreign);
    const buf = readFileSync(foreign);
    const list = readZipEntries(buf);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'a.txt');
    assert.equal(readZipEntry(buf, 'a.txt')?.toString('utf8'), 'foreign content');
  });

  it('rejects non-zip input', () => {
    assert.throws(() => readZipEntries(Buffer.from('definitely not a zip file')), /Not a ZIP/);
  });
});

describe('cbz rewrite', () => {
  it('rewrites maximum-length ASCII and Unicode archive names without extending them', async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'htosho-long-cbz-'));
    const names = ['a'.repeat(251) + '.cbz', '界'.repeat(83) + 'aa.cbz'];
    const image = Buffer.from('image data must survive');
    const metadata = Buffer.from('<ComicInfo><Series>Updated</Series></ComicInfo>');
    for (const name of names) {
      assert.equal(Buffer.byteLength(name), 255);
      writeFileSync(path.join(fixture, name), buildZip([{ name: '001.jpg', data: image }]));
    }
    await Promise.all(names.map(name => rewriteZipEntry(path.join(fixture, name), 'ComicInfo.xml', metadata)));
    for (const name of names) {
      const archive = readFileSync(path.join(fixture, name));
      assert.deepEqual(readZipEntry(archive, '001.jpg'), image);
      assert.deepEqual(readZipEntry(archive, 'ComicInfo.xml'), metadata);
    }
    assert.deepEqual(readdirSync(fixture).sort(), names.sort(), 'only the original archive names remain');
  });

  it('preserves a long-named source and removes staging files when rewriting fails', async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'htosho-long-fail-'));
    const name = 'b'.repeat(251) + '.cbz', file = path.join(fixture, name);
    writeFileSync(file, 'invalid archive');
    await assert.rejects(rewriteZipEntry(file, 'ComicInfo.xml', Buffer.from('<ComicInfo/>')), /Not a ZIP/);
    assert.equal(readFileSync(file, 'utf8'), 'invalid archive');
    assert.deepEqual(readdirSync(fixture), [name]);
  });

  it('replaces an entry, preserving all others byte-for-byte', async () => {
    const { entries } = makeSampleArchive();
    const before = readZipEntries(readFileSync(cbzPath));
    const newXml = Buffer.from('<ComicInfo><Title>New</Title></ComicInfo>', 'utf8');

    await rewriteZipEntry(cbzPath, 'ComicInfo.xml', newXml);

    const after = readZipEntries(readFileSync(cbzPath));
    assert.equal(after.length, before.length);
    for (const name of Object.keys(entries)) {
      if (name === 'ComicInfo.xml') continue;
      const b = before.find((e) => e.name === name)!;
      const a = after.find((e) => e.name === name)!;
      // Same position and payload — nothing was reordered or re-compressed.
      assert.equal(a.localOffset, b.localOffset, `${name} offset unchanged`);
      assert.ok(readZipEntry(readFileSync(cbzPath), name)?.equals(entries[name]), `${name} content intact`);
    }
    assert.equal(readComicInfoSync(cbzPath), newXml.toString('utf8'));
  });

  it('appends an entry that did not exist before', async () => {
    const { entries } = makeSampleArchive();
    await rewriteZipEntry(cbzPath, 'extra.txt', Buffer.from('added later', 'utf8'));
    const buf = readFileSync(cbzPath);
    assert.equal(readZipEntries(buf).length, Object.keys(entries).length + 1);
    assert.equal(readZipEntry(buf, 'extra.txt')?.toString('utf8'), 'added later');
    // Original entries survive the append.
    assert.ok(readZipEntry(buf, '001.jpg')?.equals(entries['001.jpg']));
  });

  it('leaves no temp file behind and keeps the original on a clean run', async () => {
    makeSampleArchive();
    await rewriteZipEntry(cbzPath, 'ComicInfo.xml', Buffer.from('<ComicInfo/>', 'utf8'));
    const leftover = readdirSync(dir).filter((n) => n.includes('.cbztmp'));
    assert.deepEqual(leftover, []);
  });
});

describe('comicinfo parse/render', () => {
  const sample = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema">',
    '  <Title><![CDATA[Sample & "Quoted" <Gallery>]]></Title>',
    '  <Series>Sample Series</Series>',
    '  <Pages><Page Image="001.jpg"/></Pages>',
    '  <Web/>',
    '</ComicInfo>',
  ].join('\n');

  it('decodes CDATA, plain, self-closing and nested tags in document order', () => {
    const doc = parseComicInfo(sample);
    assert.deepEqual(doc.order, ['Title', 'Series', 'Pages', 'Web']);
    assert.equal(doc.fields.Title, 'Sample & "Quoted" <Gallery>');
    assert.equal(doc.fields.Series, 'Sample Series');
    assert.equal(doc.fields.Web, '');
    assert.ok(doc.rawInner.Pages.includes('<Page Image="001.jpg"/>'), 'nested content kept raw');
  });

  it('round-trips untouched documents and applies edits with CDATA', () => {
    const doc = parseComicInfo(sample);
    // No edits: nested <Pages> must survive verbatim.
    const untouched = renderComicInfoXml({ values: doc.fields, order: doc.order, rawInner: doc.rawInner });
    assert.ok(untouched.includes('<Page Image="001.jpg"/>'));

    // Edit one known field + add a new one; unknown tags stay intact.
    const edited = ['Title'];
    const out = renderComicInfoXml({
      values: { ...doc.fields, Title: 'New <Title>', Year: '2026' },
      order: doc.order,
      rawInner: doc.rawInner,
      edited,
    });
    const reparsed = parseComicInfo(out);
    assert.equal(reparsed.fields.Title, 'New <Title>');
    assert.ok(out.includes('<![CDATA[New <Title>]]>'), 'edited value is CDATA-wrapped');
    assert.equal(reparsed.fields.Year, '2026');
    assert.ok(out.includes('<Page Image="001.jpg"/>'), 'unknown nested tag preserved');
    assert.ok(reparsed.order.indexOf('Pages') < reparsed.order.indexOf('Year'), 'new tags append after original order');
  });

  it('handles an XML declaration before a bare <ComicInfo> root (no attributes)', () => {
    // Real-world shape: HakuNetsu-style files with a prefix declaration and a
    // bare root tag — the body slice must start after the root's own index.
    const doc = parseComicInfo(
      [
        "<?xml version='1.0' encoding='utf-8'?>",
        '<ComicInfo>',
        '  <Manga>Yes</Manga>',
        '  <Series>Some Series</Series>',
        '  <Pages><Page Image="0" Type="FrontCover" /></Pages>',
        '  <Tags>a,b,c</Tags>',
        '</ComicInfo>',
      ].join('\n'),
    );
    assert.deepEqual(doc.order, ['Manga', 'Series', 'Pages', 'Tags']);
    assert.equal(doc.fields.Manga, 'Yes');
    assert.equal(doc.fields.Series, 'Some Series');
    assert.equal(doc.fields.Tags, 'a,b,c');
    assert.ok(doc.rawInner.Pages.includes('<Page Image="0" Type="FrontCover" />'));
  });

  it('omits empty values', () => {
    const out = renderComicInfoXml({ values: { Title: '', Series: 'Kept' }, edited: ['Title', 'Series'] });
    assert.ok(!out.includes('<Title>'));
    assert.ok(out.includes('<Series><![CDATA[Kept]]></Series>'));
  });

  it('parses documents without a ComicInfo root as empty', () => {
    const doc = parseComicInfo('<not-comicinfo/>');
    assert.deepEqual(doc.order, []);
  });
});

function readComicInfoSync(p: string): string | null {
  const buf = readFileSync(p);
  return readZipEntry(buf, 'ComicInfo.xml')?.toString('utf8') ?? null;
}

// ---------------- mergeCbzFiles ----------------


/** Build a minimal .cbz at p; include ComicInfo.xml only when xml is given. */
function makeCbz(p: string, comicInfoXml?: string): void {
  const entries = [
    { name: '001.jpg', data: Buffer.alloc(8 * 1024, 7) },
    ...(comicInfoXml ? [{ name: 'ComicInfo.xml', data: Buffer.from(comicInfoXml, 'utf8') }] : []),
  ];
  writeFileSync(p, buildZip(entries));
}

describe('mergeCbzFiles', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'htosho-merge-'));
  const srcDir = path.join(base, 'sources');

  it('moves files into one folder and stamps chapter numbers, preserving other fields', async () => {
    fs.mkdirSync(srcDir, { recursive: true });
    const ch1 = path.join(srcDir, 'ch1.cbz');
    const ch2 = path.join(srcDir, 'ch2.cbz');
    makeCbz(ch1, '<?xml version="1.0" encoding="UTF-8"?>\n<ComicInfo>\n  <Title>Chapter One</Title>\n  <Number>1</Number>\n</ComicInfo>\n');
    makeCbz(ch2); // no metadata at all
    const target = path.join(base, 'Merged Series');

    const r = await mergeCbzFiles([ch1, ch2], target, { [ch1]: '7', [ch2]: '8' });

    assert.equal(r.failed.length, 0);
    assert.deepEqual(r.moved.sort(), [path.join(target, 'ch1.cbz'), path.join(target, 'ch2.cbz')].sort());
    assert.equal(r.chaptered.length, 2);
    // Sources are gone — this is a move, not a copy.
    assert.ok(!fs.existsSync(ch1) && !fs.existsSync(ch2));
    const f1 = parseComicInfo(readComicInfoSync(path.join(target, 'ch1.cbz'))!).fields;
    assert.equal(f1.Number, '7');
    assert.equal(f1.Title, 'Chapter One'); // untouched fields survive
    const f2 = parseComicInfo(readComicInfoSync(path.join(target, 'ch2.cbz'))!).fields;
    assert.equal(f2.Number, '8');
  });

  it('resolves name collisions with a numeric suffix', async () => {
    fs.mkdirSync(srcDir, { recursive: true });
    const incoming = path.join(srcDir, 'dup.cbz');
    makeCbz(incoming, '<ComicInfo><Title>Incoming</Title></ComicInfo>');
    const target = path.join(base, 'Collision');
    fs.mkdirSync(target);
    makeCbz(path.join(target, 'dup.cbz'), '<ComicInfo><Title>Existing</Title></ComicInfo>');

    const r = await mergeCbzFiles([incoming], target);

    assert.equal(r.failed.length, 0);
    assert.equal(r.moved[0], path.join(target, 'dup (2).cbz'));
    assert.ok(fs.existsSync(path.join(target, 'dup.cbz')));
    assert.equal(readComicInfoSync(path.join(target, 'dup.cbz'))?.includes('Existing'), true);
  });

  it('keeps files already in the target folder in place and still stamps them', async () => {
    const target = path.join(base, 'InPlace');
    fs.mkdirSync(target);
    const here = path.join(target, 'here.cbz');
    makeCbz(here);

    const r = await mergeCbzFiles([here], target, { [here]: '3' });

    assert.equal(r.failed.length, 0);
    assert.equal(r.moved[0], here);
    assert.equal(parseComicInfo(readComicInfoSync(here)!).fields.Number, '3');
  });

  it('reports missing and non-cbz sources as failures instead of throwing', async () => {
    fs.mkdirSync(srcDir, { recursive: true });
    const note = path.join(srcDir, 'notes.txt');
    writeFileSync(note, 'not an archive');
    const target = path.join(base, 'Failures');

    const r = await mergeCbzFiles([path.join(srcDir, 'missing.cbz'), note], target);

    assert.equal(r.moved.length, 0);
    assert.equal(r.failed.length, 2);
    assert.match(r.failed[0].error, /not found/);
    assert.match(r.failed[1].error, /not a \.cbz/);
  });

  it('rejects a relative target directory', async () => {
    await assert.rejects(() => mergeCbzFiles([], 'relative/dir'), /absolute/);
  });

  it('removes source folders left empty by the move but keeps folders with other content', async () => {
    const vol1 = path.join(base, 'Series A', 'vol1');
    const vol2 = path.join(base, 'Series B', 'vol2');
    fs.mkdirSync(vol1, { recursive: true });
    fs.mkdirSync(vol2, { recursive: true });
    makeCbz(path.join(vol1, 'a.cbz'));
    makeCbz(path.join(vol2, 'b.cbz'));
    writeFileSync(path.join(vol2, 'keep.txt'), 'stay'); // vol2 must survive
    const target = path.join(base, 'Merged Cleanup');

    const r = await mergeCbzFiles([path.join(vol1, 'a.cbz'), path.join(vol2, 'b.cbz')], target);

    assert.equal(r.failed.length, 0);
    assert.equal(r.moved.length, 2);
    assert.ok(!fs.existsSync(vol1), 'emptied source folder should be removed');
    assert.ok(fs.existsSync(path.join(vol2, 'keep.txt')), 'non-empty source folder must survive');
    assert.ok(fs.existsSync(target));
  });

  it('stamps the merged series name into ComicInfo.Series so Kavita keeps one series', async () => {
    const vol1 = path.join(base, 'Series C', 'vol1');
    const vol2 = path.join(base, 'Series C', 'vol2');
    fs.mkdirSync(vol1, { recursive: true });
    fs.mkdirSync(vol2, { recursive: true });
    makeCbz(path.join(vol1, 'a.cbz'), '<ComicInfo><Series>Old Name A</Series></ComicInfo>');
    makeCbz(path.join(vol2, 'b.cbz')); // no metadata at all
    const target = path.join(base, 'Merged Series C');

    const r = await mergeCbzFiles([path.join(vol1, 'a.cbz'), path.join(vol2, 'b.cbz')], target, {}, 'Merged Series C');

    assert.equal(r.failed.length, 0);
    assert.equal(r.moved.length, 2);
    const f1 = parseComicInfo(readComicInfoSync(path.join(target, 'a.cbz'))!).fields;
    assert.equal(f1.Series, 'Merged Series C');
    const f2 = parseComicInfo(readComicInfoSync(path.join(target, 'b.cbz'))!).fields;
    assert.equal(f2.Series, 'Merged Series C');
  });
});

describe('resolveSeriesHostDir', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'htosho-resolve-'));
  // Local anchor stands in for the container download directory (/mnt/downloads).
  const anchor = path.join(base, 'downloads');
  fs.mkdirSync(path.join(anchor, 'Series A'), { recursive: true });
  fs.mkdirSync(path.join(anchor, 'Genre', 'Series B'), { recursive: true });
  // A library folder that exists locally (native install or identical mount point).
  const nativeLib = path.join(base, 'media', 'Doujins');
  fs.mkdirSync(path.join(nativeLib, 'Series C'), { recursive: true });
  fs.mkdirSync(path.join(nativeLib, 'Solo'), { recursive: true });
  // An anchor whose folder name matches a remote library path (Z:\Doujins style).
  const zMount = path.join(base, 'Z', 'Doujins');
  fs.mkdirSync(path.join(zMount, 'Series A'), { recursive: true });

  it('uses the library path directly when it exists locally', () => {
    const got = resolveSeriesHostDir({
      libraryPath: nativeLib,
      folderPath: `${nativeLib}/Series C`,
      anchors: [anchor],
    });
    assert.equal(got, path.join(nativeLib, 'Series C'));
  });

  it('matches an anchor by folder name when the library path is foreign', () => {
    const got = resolveSeriesHostDir({
      libraryPath: path.join(base, 'remote', 'Doujins'), // does not exist locally
      folderPath: `${base}/remote/Doujins/Series A`,
      anchors: [zMount],
    });
    assert.equal(got, path.join(zMount, 'Series A'));
  });

  it('falls back to the series folder name under the anchor when mount points differ (Docker)', () => {
    const got = resolveSeriesHostDir({
      libraryPath: '/media/Doujins',
      folderPath: '/media/Doujins/Series A',
      anchors: [anchor],
    });
    assert.equal(got, path.join(anchor, 'Series A'));
  });

  it('prefers deeper trailing segments over bare name matches', () => {
    const got = resolveSeriesHostDir({
      libraryPath: '/media/Doujins',
      folderPath: '/media/Doujins/Genre/Series B',
      anchors: [anchor],
    });
    assert.equal(got, path.join(anchor, 'Genre', 'Series B'));
  });

  it('returns null when no anchor contains the series folder', () => {
    const got = resolveSeriesHostDir({
      libraryPath: '/media/Doujins',
      folderPath: '/media/Doujins/Ghost Series',
      anchors: [anchor],
    });
    assert.equal(got, null);
  });

  it('returns the library root for a series stored at the library root', () => {
    const got = resolveSeriesHostDir({
      libraryPath: nativeLib,
      folderPath: nativeLib,
      anchors: [anchor],
    });
    assert.equal(got, nativeLib);
  });

  it('recovers a stale Kavita subpath from the trailing segments that still exist', () => {
    const got = resolveSeriesHostDir({
      libraryPath: nativeLib,
      folderPath: `${nativeLib}/Old/Solo`, // Old/ no longer exists locally
      anchors: [],
    });
    assert.equal(got, path.join(nativeLib, 'Solo'));
  });

  it('returns null when required inputs are missing', () => {
    assert.equal(resolveSeriesHostDir({ libraryPath: nativeLib, folderPath: null, anchors: [anchor] }), null);
    assert.equal(resolveSeriesHostDir({ libraryPath: null, folderPath: '/x/y', anchors: [anchor] }), null);
  });

  it('uses an explicit library mapping instead of a same-named download folder', () => {
    assert.equal(resolveSeriesHostDir({
      libraryPath: '/kavita/Manga', folderPath: '/kavita/Manga/Series A', anchors: [zMount],
      mappings: [{ kavitaPath: '/kavita/Manga', localPath: anchor }],
    }), path.join(anchor, 'Series A'));
  });

  it('prefers the most specific mapping and supports foreign Windows paths', () => {
    assert.equal(resolveSeriesHostDir({
      folderPath: 'z:\\Manga\\Genre\\Series B', anchors: [],
      mappings: [{ kavitaPath: 'Z:\\Manga', localPath: zMount }, { kavitaPath: 'Z:\\Manga\\Genre', localPath: path.join(anchor, 'Genre') }],
    }), path.join(anchor, 'Genre', 'Series B'));
  });

  it('does not fall back to a different library when an explicit mount is unavailable', () => {
    assert.equal(resolveSeriesHostDir({
      libraryPath: '/media/Manga', folderPath: '/media/Manga/Series A', anchors: [anchor],
      mappings: [{ kavitaPath: '/media/Manga', localPath: path.join(base, 'missing-mount') }],
    }), null);
  });

  it('maps library roots and rejects traversal and partial prefix matches', () => {
    const mappings = [{ kavitaPath: '/media/Manga', localPath: anchor }];
    assert.equal(resolveSeriesHostDir({ folderPath: '/media/Manga', anchors: [], mappings }), anchor);
    assert.equal(resolveSeriesHostDir({ folderPath: '/media/Manga/../Doujins', anchors: [], mappings }), null);
    assert.equal(resolveSeriesHostDir({ folderPath: '/media/Manga-extra/Series A', anchors: [], mappings }), null);
  });
});

/**
 * Single-entry archive with a DEFLATED image payload — our own writer stores
 * images (method 0), so this emulates a foreign tool that compresses them.
 */
function makeDeflatedImageArchive(p: string, data: Buffer): void {
  const name = Buffer.from('001.jpg', 'utf8');
  const compressed = deflateRawSync(data);
  const crc = crc32(data) >>> 0;

  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6); // no flags
  local.writeUInt16LE(8, 8); // deflated
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  name.copy(local, 30);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10); // deflated
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt32LE(0, 42); // local offset
  name.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + compressed.length, 16);

  writeFileSync(p, Buffer.concat([local, compressed, central, eocd]));
}

describe('readCoverImage', () => {
  it('returns the first image entry of a cbz in archive order', async () => {
    const { entries } = makeSampleArchive();
    const img = await readCoverImage(cbzPath);
    assert.ok(img);
    assert.equal(img.mime, 'image/jpeg');
    assert.ok(img.data.equals(entries['001.jpg']));
  });

  it('recognizes modern image formats like AVIF (Hitomi galleries)', async () => {
    const p = path.join(dir, 'avif.cbz');
    const page = Buffer.alloc(16 * 1024, 3);
    writeFileSync(p, buildZip([
      { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo/>') },
      { name: '01.avif', data: page },
      { name: '02.avif', data: Buffer.alloc(16 * 1024, 4) },
    ]));
    const img = await readCoverImage(p);
    assert.ok(img);
    assert.equal(img.mime, 'image/avif');
    assert.ok(img.data.equals(page));
  });

  it('inflates deflated image entries written by foreign tools', async () => {
    const p = path.join(dir, 'deflated.cbz');
    const data = Buffer.alloc(32 * 1024, 7);
    makeDeflatedImageArchive(p, data);
    const img = await readCoverImage(p);
    assert.ok(img);
    assert.equal(img.mime, 'image/jpeg');
    assert.ok(img.data.equals(data));
  });

  it('returns null for archives without image entries', async () => {
    const p = path.join(dir, 'text-only.cbz');
    writeFileSync(p, buildZip([
      { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo/>') },
      { name: 'notes.txt', data: Buffer.from('hi') },
    ]));
    assert.equal(await readCoverImage(p), null);
  });

  it('returns the first image of a folder in name order, skipping non-images', async () => {
    const f = path.join(dir, 'folder-out');
    fs.mkdirSync(f, { recursive: true });
    writeFileSync(path.join(f, '001.jpg'), Buffer.from('jpg-bytes'));
    writeFileSync(path.join(f, '002.png'), Buffer.from('png-bytes'));
    writeFileSync(path.join(f, 'ComicInfo.xml'), Buffer.from('<ComicInfo/>'));
    const img = await readCoverImage(f);
    assert.ok(img);
    assert.equal(img.mime, 'image/jpeg');
    assert.deepEqual(img.data, Buffer.from('jpg-bytes'));
  });

  it('returns null for missing paths and image-less folders', async () => {
    assert.equal(await readCoverImage(path.join(dir, 'nope.cbz')), null);
    const f = path.join(dir, 'empty-folder');
    fs.mkdirSync(f, { recursive: true });
    writeFileSync(path.join(f, 'ComicInfo.xml'), Buffer.from('<ComicInfo/>'));
    assert.equal(await readCoverImage(f), null);
  });
});
