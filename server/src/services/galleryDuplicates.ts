import fs from 'node:fs';
import path from 'node:path';
import { getDb, schema } from '../db/index.js';
import { getDownloaderSettings, getKavitaConnection } from './settings.js';
import { eq } from 'drizzle-orm';
import type { KavitaLibrary } from '../kavita/types.js';
import { getDoujinProvider } from '../downloader/providers.js';
import type { DoujinGallery } from '../downloader/types.js';
import type { DoujinSource } from '../contracts/doujin.js';
import { readComicInfo, listCbzImages, mapKavitaPathToLocalPath } from '../lib/cbz.js';
import { parseComicInfo } from '../downloader/comicinfo.js';
import { mapLimit } from '../lib/http.js';
import { onEhentaiAccountChange } from './ehentaiAccount.js';

// A preflight resolves metadata, never image bytes. Reuse that result at enqueue
// and consume it in the worker so duplicate checking does not double provider traffic.
const prepared = new Map<string, { provider: unknown; at: number; gallery: Promise<DoujinGallery> }>();

// An account/site cutover changes which galleries are even visible (ExHentai
// vs public E-Hentai): stale preflights must not survive the change.
onEhentaiAccountChange(() => { prepared.clear(); });
export async function resolveDuplicateGallery(source: DoujinSource, galleryId: string, consume = false): Promise<DoujinGallery> {
  const provider = getDoujinProvider(source);
  if (!provider) throw new Error(`Unknown source: ${source}`);
  const key = `${source}:${galleryId}`;
  let cached = prepared.get(key);
  if (!cached || cached.provider !== provider.getGallery || Date.now() - cached.at > 60_000) {
    cached = { provider: provider.getGallery, at: Date.now(), gallery: provider.getGallery(galleryId) };
    prepared.set(key, cached);
    while (prepared.size > 64) prepared.delete(prepared.keys().next().value!);
  }
  if (consume) prepared.delete(key);
  try { return await cached.gallery; }
  catch (error) { if (prepared.get(key) === cached) prepared.delete(key); throw error; }
}

export interface GalleryIdentity {
  source: string;
  galleryId: string;
  title: string;
  titleAlt?: string;
  artists: string[];
  language?: string | null;
  pageCount?: number;
  path?: string;
  stamp?: string;
  sourceKeys?: string[];
}
export interface DuplicateMatch {
  title: string;
  source: string;
  galleryId: string;
  artists: string[];
  language?: string | null;
  pageCount?: number;
  path?: string;
  taskId?: number;
  status: string;
  reasons: string[];
  confirmed?: boolean;
}
export interface DuplicateReport { source: DoujinSource; galleryId: string; title: string; matches: DuplicateMatch[] }

const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
function sourceKeys(web: string): string[] {
  return [...web.matchAll(/https?:\/\/[^\s<>"',;]+/gi)].flatMap(([value]) => {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      const hitomi = host === 'hitomi.la' && (url.pathname.match(/^\/(?:reader\/|[^/]+\/)(?:[^/]*-)?(\d+)\.html$/) || url.pathname.match(/^\/(\d+)\/?$/));
      const nhentai = host === 'nhentai.net' && url.pathname.match(/^\/g\/(\d+)\/?$/);
      return hitomi ? [`hitomi:${hitomi[1]}`] : nhentai ? [`nhentai:${nhentai[1]}`] : [];
    } catch { return []; }
  });
}
function titleKeys(identity: GalleryIdentity): Set<string> {
  return new Set([identity.title, identity.titleAlt ?? ''].flatMap(title => {
    // Keep digits and chapter/volume identifiers. Only source wrapper annotations disappear.
    const work = title.replace(/^(?:\([^)]*\)\s*)?\[[^\]]+\]\s*/, '')
      .replace(/\s*\[([^\]]+)\]\s*$/g, (annotation, label: string) => /\d|chapter|volume|part|final/i.test(label) ? annotation : '').trim();
    const unwrapped = work.replace(/(?:\s*\[[^\]\d]+\])+\s*$/g, (annotations) => /chapter|volume|part|final/i.test(annotations) ? annotations : '');
    return [normalize(title), normalize(work), normalize(unwrapped)].filter(key => key.length >= 6);
  }));
}
function languageKey(value?: string | null): string {
  const key = normalize(value ?? '');
  const aliases: Record<string, string> = { en: 'english', eng: 'english', ja: 'japanese', jp: 'japanese', jpn: 'japanese', zh: 'chinese', zho: 'chinese', chi: 'chinese', ko: 'korean', kor: 'korean', de: 'german', deu: 'german', ger: 'german', fr: 'french', fra: 'french', fre: 'french', es: 'spanish', spa: 'spanish' };
  return ['unknown', 'und', 'none'].includes(key) ? '' : aliases[key] ?? key;
}

/** Conservative metadata evidence, never a claim of byte-identical content. */
export function duplicateReasons(a: GalleryIdentity, b: GalleryIdentity): string[] {
  const titles = titleKeys(b);
  if (![...titleKeys(a)].some(title => titles.has(title))) return [];
  const artists = new Set(b.artists.map(normalize).filter(Boolean));
  if (!a.artists.some(artist => artists.has(normalize(artist)))) return [];
  const languageA = languageKey(a.language), languageB = languageKey(b.language);
  if (languageA && languageB && languageA !== languageB) return [];
  if (a.pageCount && b.pageCount && a.pageCount !== b.pageCount) return [];
  return ['Same title', 'Same artist', ...(languageA && languageB ? ['Same language'] : []), ...(a.pageCount && b.pageCount ? ['Same page count'] : [])];
}

const storeKey = (identity: GalleryIdentity) => identity.path ? `duplicate-file:${identity.path}` : `duplicate-gallery:${identity.source}:${identity.galleryId}`;
export function recordGalleryIdentity(gallery: DoujinGallery): GalleryIdentity {
  const identity: GalleryIdentity = { source: gallery.source, galleryId: gallery.galleryId, title: gallery.title, titleAlt: gallery.titleAlt, artists: gallery.artists ?? [], language: gallery.language, pageCount: gallery.pages.length || gallery.pageCount };
  saveIdentity(identity);
  return identity;
}
function saveIdentity(identity: GalleryIdentity): void {
  const valueJson = JSON.stringify(identity);
  getDb().insert(schema.keyValueStore).values({ key: storeKey(identity), valueJson }).onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson } }).run();
}
function storedIdentities(): GalleryIdentity[] {
  return getDb().select().from(schema.keyValueStore).all().filter(row => row.key.startsWith('duplicate-')).flatMap(row => {
    try { return [JSON.parse(row.valueJson) as GalleryIdentity]; } catch { return []; }
  });
}

let scan: Promise<void> | null = null;
let scannedAt = 0;
let rootsKey = '';
let availableFiles = new Set<string>();
let warnings: string[] = [];
export function invalidateDuplicateLibrary(): void { scannedAt = 0; }

/** Learn folders from normal library browsing; downloading never waits for Kavita. */
export function rememberDuplicateLibraryRoots(libraries: KavitaLibrary[]): void {
  const valueJson = JSON.stringify({ baseUrl: getKavitaConnection().baseUrl, paths: libraries.flatMap(library => library.paths ?? (library.path ? [library.path] : [])) });
  getDb().insert(schema.keyValueStore).values({ key: 'library-duplicate-roots', valueJson }).onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson } }).run();
  invalidateDuplicateLibrary();
}

async function scanLibrary(): Promise<void> {
  const settings = getDownloaderSettings();
  const conn = getKavitaConnection();
  const key = JSON.stringify([settings.downloadDirectory, settings.libraryPathMappings, conn.baseUrl, conn.apiKey]);
  if (key === rootsKey && Date.now() - scannedAt < 5 * 60_000) return;
  if (scan) { await scan; return scanLibrary(); }
  scan = (async () => {
    const problems: string[] = [];
    let missingMetadata = 0;
    const roots = [settings.downloadDirectory, ...(settings.libraryPathMappings ?? []).map(mapping => mapping.localPath)].filter(Boolean);
    const storedRoots = getDb().select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, 'library-duplicate-roots')).get();
    let rootsKnown = false;
    if (storedRoots) {
      try {
        const known = JSON.parse(storedRoots.valueJson) as { baseUrl: string; paths: string[] };
        if (known.baseUrl === conn.baseUrl) { rootsKnown = true; roots.push(...known.paths.map(root => mapKavitaPathToLocalPath(root, settings.libraryPathMappings) ?? root)); }
      } catch { problems.push('Saved library folders could not be checked. Open Libraries to refresh them.'); }
    }
    if (conn.baseUrl && conn.apiKey && !rootsKnown && !settings.libraryPathMappings?.length) problems.push('Library folders are not indexed yet. Open Libraries or configure folder mappings.');
    const files = new Set<string>();
    const visited = new Set<string>();
    async function walk(dir: string): Promise<void> {
      const absolute = path.resolve(dir);
      if (visited.has(absolute)) return;
      visited.add(absolute);
      try {
        const entries = await fs.promises.readdir(absolute, { withFileTypes: true });
        for (const entry of entries) {
          const file = path.join(absolute, entry.name);
          if (entry.isDirectory() && !entry.name.startsWith('.')) await walk(file);
          else if (entry.isFile() && /\.cbz$/i.test(entry.name)) files.add(file);
        }
      } catch (error) {
        // A new output directory may not exist until the first download.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problems.push(`Could not check folder: ${absolute}`);
        else if (absolute !== path.resolve(settings.downloadDirectory || '.')) problems.push(`Library folder unavailable: ${absolute}`);
      }
    }
    for (const root of new Set(roots)) await walk(root);
    const previous = new Map(storedIdentities().filter(identity => identity.path).map(identity => [identity.path!, identity]));
    await mapLimit([...files], 6, async file => {
      try {
        const stat = await fs.promises.stat(file);
        const stamp = `v3:${stat.mtimeMs}:${stat.size}`;
        if (previous.get(file)?.stamp === stamp) return;
        const raw = await readComicInfo(file);
        if (!raw) { missingMetadata++; files.delete(file); return; }
        const fields = parseComicInfo(raw).fields;
        const artists = `${fields.Artist ?? ''},${fields.Writer ?? ''}`.split(/[,;]/).map(artist => artist.trim()).filter(Boolean);
        const title = fields.Title?.trim() || fields.Series?.trim() || '';
        const filenameKey = path.basename(file).match(/\[(hitomi|nhentai)-(\d+)\]\.cbz$/i);
        const keys = [...new Set([...sourceKeys(fields.Web ?? ''), ...(filenameKey ? [`${filenameKey[1].toLowerCase()}:${filenameKey[2]}`] : [])])];
        if ((!title || !artists.length) && !keys.length) { missingMetadata++; files.delete(file); return; }
        const count = (await listCbzImages(file)).length;
        const originalFilename = path.basename(file).replace(/\.cbz$/i, '').replace(/\s*\[(?:hitomi|nhentai)-\d+\]$/i, '').trim();
        saveIdentity({ source: 'library', galleryId: file, path: file, title: title || originalFilename, titleAlt: originalFilename, artists, language: fields.LanguageISO || fields.Language, pageCount: count, stamp, sourceKeys: keys });
      } catch { files.delete(file); problems.push(`Could not read archive metadata: ${file}`); }
    });
    availableFiles = files;
    if (missingMetadata) problems.push(`${missingMetadata} archive${missingMetadata === 1 ? '' : 's'} missing title or artist metadata could not be compared.`);
    warnings = problems.length > 10 ? [...problems.slice(0, 10), `${problems.length - 10} additional archive or folder warnings.`] : problems;
    rootsKey = key;
    scannedAt = Date.now();
  })();
  try { await scan; } finally { scan = null; }
}

export async function prepareDuplicateCheck(items: { source: DoujinSource; galleryId: string }[], refresh = false): Promise<GalleryIdentity[]> {
  if (refresh) invalidateDuplicateLibrary();
  const identities = await mapLimit(items, 3, async item => {
    const gallery = await resolveDuplicateGallery(item.source, item.galleryId);
    return recordGalleryIdentity(gallery);
  });
  await scanLibrary();
  return identities;
}

/** Search results already contain enough metadata; never fetch provider pages for a card badge. */
export async function lookupLibraryMatches(items: GalleryIdentity[]) {
  await scanLibrary();
  return findDuplicateReports(items, [], true);
}

/** Synchronous check immediately before enqueue closes races with other requests. */
export function findDuplicateReports(incoming: GalleryIdentity[], excludedPaths: string[] = [], includeOwned = false): { reports: DuplicateReport[]; warnings: string[] } {
  const db = getDb();
  const tasks = db.select().from(schema.downloadQueue).all().filter(task => ['completed', 'queued', 'downloading', 'paused'].includes(task.status));
  const owned = new Set(db.select().from(schema.ownedGalleries).all().map(row => `${row.source}:${row.galleryId}`));
  const tasksByGallery = new Map(tasks.map(task => [`${task.source}:${task.galleryId}`, task]));
  const excluded = new Set(excludedPaths.map(file => path.resolve(file)));
  const candidates = storedIdentities().filter(identity => identity.path ? availableFiles.has(identity.path) && !excluded.has(identity.path) : owned.has(`${identity.source}:${identity.galleryId}`) || tasksByGallery.has(`${identity.source}:${identity.galleryId}`));
  // Older downloads already have title/artist/language profiles; no provider backfill is needed.
  const known = new Set(candidates.map(storeKey));
  if (includeOwned) for (const item of incoming) {
    const key = `${item.source}:${item.galleryId}`;
    if ((owned.has(key) || tasksByGallery.has(key)) && !known.has(storeKey(item))) candidates.push({ ...item });
  }
  for (const row of db.select().from(schema.galleryTags).all()) {
    const identity: GalleryIdentity = { source: row.source, galleryId: row.galleryId, title: row.title ?? '', artists: [], language: row.language };
    try { identity.artists = JSON.parse(row.artistsJson); } catch { continue; }
    if (!known.has(storeKey(identity)) && (owned.has(`${row.source}:${row.galleryId}`) || tasksByGallery.has(`${row.source}:${row.galleryId}`))) candidates.push(identity);
  }
  const byTitle = new Map<string, Set<GalleryIdentity>>();
  for (const candidate of includeOwned ? candidates : [...candidates, ...incoming]) {
    for (const title of titleKeys(candidate)) {
      if (!byTitle.has(title)) byTitle.set(title, new Set());
      byTitle.get(title)!.add(candidate);
    }
  }
  return { reports: incoming.map(item => {
    const matches: DuplicateMatch[] = [];
    const seen = new Set<string>();
    const titleMatches = new Set([...titleKeys(item)].flatMap(title => [...(byTitle.get(title) ?? [])]));
    for (const candidate of candidates) if (candidate.sourceKeys?.includes(`${item.source}:${item.galleryId}`) || (includeOwned && candidate.source === item.source && candidate.galleryId === item.galleryId)) titleMatches.add(candidate);
    for (const candidate of titleMatches) {
      const confirmed = candidates.includes(candidate) && (candidate.sourceKeys?.includes(`${item.source}:${item.galleryId}`) || (includeOwned && candidate.source === item.source && candidate.galleryId === item.galleryId));
      if (!confirmed && candidate.source === item.source && candidate.galleryId === item.galleryId) continue;
      if (!confirmed && !candidate.path && candidate.source === item.source) continue;
      const reasons = confirmed ? ['Same source gallery'] : duplicateReasons(item, candidate);
      if (!reasons.length || seen.has(storeKey(candidate)) || (candidate.path && !fs.existsSync(candidate.path))) continue;
      seen.add(storeKey(candidate));
      const task = tasksByGallery.get(`${candidate.source}:${candidate.galleryId}`);
      matches.push({ title: candidate.title, source: candidate.source, galleryId: candidate.galleryId, artists: candidate.artists, language: candidate.language, pageCount: candidate.pageCount, path: candidate.path ?? task?.outputPath ?? undefined, taskId: task?.id, status: candidate.path ? 'In library' : task?.status ?? (owned.has(`${candidate.source}:${candidate.galleryId}`) ? 'Owned' : 'In selection'), reasons, confirmed: !!confirmed });
    }
    return { source: item.source as DoujinSource, galleryId: item.galleryId, title: item.title, matches };
  }), warnings: [...warnings] };
}
