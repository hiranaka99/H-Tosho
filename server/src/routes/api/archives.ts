import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { getDownloaderSettings } from '../../services/settings.js';
import { imageMime, listCbzFilesAsync, listCbzImages, readComicInfo, readZipEntryFromDisk, resolveExistingFileAsync, resolveSeriesHostDir } from '../../lib/cbz.js';
import { mapLimit } from '../../lib/http.js';
import { parseComicInfo } from '../../downloader/comicinfo.js';

import { connectedClient, errMsg, intParam } from './helpers.js';
export const api = new Hono();
api.get('/cbz/roots', async (c) => {
  const roots: string[] = [];
  const dl = getDownloaderSettings();
  if (dl.downloadDirectory) roots.push(path.resolve(dl.downloadDirectory));
  for (const mapping of dl.libraryPathMappings ?? []) roots.push(path.resolve(mapping.localPath));
  const client = connectedClient();
  if (client) {
    try {
      for (const lib of await client.getLibraries()) {
        roots.push(...(lib.paths ?? (lib.path ? [lib.path] : [])));
      }
    } catch {
      /* Kavita unreachable — the download directory is still a valid root */
    }
  }
  // Async stats: library paths may live on network drives, where a blocking
  // statSync would stall the event loop (and every other request) per syscall.
  const unique = [...new Set(roots)];
  const ok = await Promise.all(
    unique.map(async (r) => {
      try {
        return (await fs.promises.stat(r)).isDirectory();
      } catch {
        return false;
      }
    }),
  );
  return c.json({ roots: unique.filter((_, i) => ok[i]) });
});

/** List subdirectories and .cbz files of a directory for the file browser. */
api.get('/cbz/browse', async (c) => {
  const dir = c.req.query('path');
  if (!dir || !path.isAbsolute(dir)) return c.json({ error: 'Absolute directory path required' }, 400);
  const full = path.resolve(dir);
  let entries;
  try {
    // Async read: the browsed directory may be a network drive, where a
    // blocking readdirSync would stall the event loop for the whole syscall.
    entries = await fs.promises.readdir(full, { withFileTypes: true });
  } catch {
    return c.json({ error: 'Directory not found or not readable' }, 404);
  }
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  const files = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.cbz'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  const parent = path.dirname(full);
  return c.json({ path: full, parent: parent === full ? null : parent, dirs, files });
});

/** Read and parse the ComicInfo.xml embedded in a .cbz (null entry when absent). */
api.get('/cbz/comicinfo', async (c) => {
  const file = c.req.query('path');
  const full = file ? await resolveExistingFileAsync(file) : null;
  if (!full || !full.toLowerCase().endsWith('.cbz')) {
    return c.json({ error: 'Path must point to an existing .cbz file' }, 400);
  }
  let xml: string | null;
  try {
    xml = await readComicInfo(full);
  } catch (e) {
    return c.json({ error: errMsg(e) }, 500);
  }
  if (!xml) return c.json({ path: full, hasEntry: false, fields: {}, order: [], raw: null });
  const doc = parseComicInfo(xml);
  return c.json({ path: full, hasEntry: true, fields: doc.fields, order: doc.order, raw: xml });
});

/** List the image entries (pages) of a .cbz in reading order. */
api.get('/cbz/images', async (c) => {
  const file = c.req.query('path');
  const full = file ? await resolveExistingFileAsync(file) : null;
  if (!full || !full.toLowerCase().endsWith('.cbz')) {
    return c.json({ error: 'Path must point to an existing .cbz file' }, 400);
  }
  try {
    const images = await listCbzImages(full);
    return c.json({ path: full, images });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 500);
  }
});

/** Serve one page image from a .cbz (positional read of a single entry). */
api.get('/cbz/page', async (c) => {
  const file = c.req.query('path');
  const name = c.req.query('name');
  const full = file ? await resolveExistingFileAsync(file) : null;
  if (!full || !full.toLowerCase().endsWith('.cbz') || !name) {
    return c.json({ error: 'Path and entry name are required' }, 400);
  }
  const mime = imageMime(name);
  if (!mime) return c.json({ error: 'Entry is not a recognized image' }, 400);
  try {
    const buf = await readZipEntryFromDisk(full, name);
    return new Response(buf, { status: 200, headers: { 'Content-Type': mime, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 404);
  }
});

/** List the .cbz archives on disk for a Kavita series (host-side path resolution). */
api.get('/cbz/series/:id', async (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid series id' }, 400);
  const client = connectedClient();
  if (!client) return c.json({ error: 'Kavita not configured' }, 503);
  let s;
  try {
    s = await client.getSeriesById(id);
  } catch (e) {
    return c.json({ error: errMsg(e) }, 404);
  }
  const libraries = await client.getLibraries();
  const lib = libraries.find((l) => l.id === s.libraryId);
  const dl = getDownloaderSettings();
  const dir = resolveSeriesHostDir({
    libraryPath: lib?.path,
    folderPath: s.folderPath,
    anchors: dl.downloadDirectory ? [path.resolve(dl.downloadDirectory)] : [],
    mappings: dl.libraryPathMappings });
  const dirExists = dir ? await fs.promises.access(dir).then(() => true, () => false) : false;
  if (!dir || !dirExists) {
    return c.json({ seriesId: id, name: s.name, dir: null, reason: 'Could not locate this series on this machine — type a path manually.', files: [] });
  }
  const files = await listCbzFilesAsync(dir);
  // Prefill chapter numbers (merge dialog) from the archives' existing metadata.
  // Bounded: a large series must not open every archive at once.
  const chapterNumbers: Record<string, string> = {};
  await mapLimit(files, 8, async (f) => {
    try {
      const xml = await readComicInfo(f);
      if (xml) {
        const n = parseComicInfo(xml).fields.Number;
        if (n && n.trim()) chapterNumbers[f] = n.trim();
      }
    } catch {
      // unreadable archive — leave the prefill empty
    }
  });
  return c.json({ seriesId: id, name: s.name, dir, reason: null, files, chapterNumbers });
});
// ---------------- Jobs ----------------
