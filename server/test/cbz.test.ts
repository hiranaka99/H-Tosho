import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { describe, it } from 'node:test';

import { readComicInfo, readZipEntries, readZipEntry, rewriteZipEntry, mergeCbzFiles } from '../src/lib/cbz.js';
import { buildZip } from '../src/downloader/zip.js';
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
