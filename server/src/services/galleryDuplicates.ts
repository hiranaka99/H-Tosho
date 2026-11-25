import fs from 'node:fs';
import path from 'node:path';
import { getDb, schema } from '../db/index.js';
import { getDownloaderSettings, getKavitaConnection } from './settings.js';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { KavitaLibrary } from '../kavita/types.js';
import { getDoujinProvider } from '../downloader/providers.js';
import type { DoujinGallery } from '../downloader/types.js';
import { parseEhentaiGalleryId, parseEhentaiGalleryUrl, type DoujinSource } from '../contracts/doujin.js';
import { readComicInfoAndImageCount, mapKavitaPathToLocalPath } from '../lib/cbz.js';
import { parseComicInfo } from '../downloader/comicinfo.js';
import { mapLimit } from '../lib/http.js';
import { getEhentaiAccountSite, onEhentaiAccountChange } from './ehentaiAccount.js';
import { censorshipEdition, withoutCensorshipLabels, type CensorshipEdition } from './unifiedTitle.js';

// A preflight resolves metadata, never image bytes. Reuse that result at enqueue
// and consume it in the worker so duplicate checking does not double provider traffic.
const prepared = new Map<string, { provider: unknown; at: number; gallery: Promise<DoujinGallery> }>();

// An account/site cutover changes which galleries are even visible (ExHentai
// vs public E-Hentai): stale preflights must not survive the change.
onEhentaiAccountChange(() => { prepared.clear(); });

/** Canonical cache key so preflight lookups by bare galleryId and worker lookups by frozen URL share one entry. */
function duplicateCacheKey(source: DoujinSource, idOrUrl: string): string {
  const trimmed = idOrUrl.trim();
  if (source === 'hitomi') {
    if (/^\d+$/.test(trimmed)) return `hitomi:${trimmed}`;
    try {
      const url = new URL(trimmed);
      if (url.hostname === 'hitomi.la' && (url.protocol === 'https:' || url.protocol === 'http:')) {
        const id = url.pathname.match(/^\/(?:reader|galleries)\/(\d+)\.html$/)?.[1]
          ?? url.pathname.match(/^\/[^/]+\/[^/]+-(\d+)\.html$/)?.[1]
          ?? url.pathname.match(/^\/(\d+)\/?$/)?.[1];
        if (id) return `hitomi:${id}`;
      }
    } catch { /* fall through */ }
  } else if (source === 'nhentai') {
    const id = /^\d+$/.test(trimmed) ? trimmed : /\/(?:g|gallery)\/(\d+)/.exec(trimmed)?.[1];
    if (id) return `nhentai:${id}`;
  } else if (source === 'ehentai') {
    const fromUrl = parseEhentaiGalleryUrl(trimmed);
    if (fromUrl) return `ehentai:${fromUrl.site}:${fromUrl.canonicalId}`;
    const fromId = parseEhentaiGalleryId(trimmed);
    if (fromId) {
      let site = 'e-hentai';
      try { site = getEhentaiAccountSite(); } catch { /* default */ }
      return `ehentai:${site}:${fromId.canonicalId}`;
    }
  }
  return `${source}:${trimmed}`;
}

export async function resolveDuplicateGallery(source: DoujinSource, galleryId: string, consume = false): Promise<DoujinGallery> {
  const provider = getDoujinProvider(source);
  if (!provider) throw new Error(`Unknown source: ${source}`);
  const key = duplicateCacheKey(source, galleryId);
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
  /** Source tags of an incoming gallery; only their censorship edition is retained when stored. */
  tags?: string[];
  /** Censorship edition stated by tags (title labels are read separately). */
  edition?: 'uncensored' | 'censored';
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
  /** The checked gallery is an uncensored/decensored edition of this owned copy. */
  betterEdition?: boolean;
}
export interface DuplicateReport { source: DoujinSource; galleryId: string; title: string; matches: DuplicateMatch[] }

const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
function sourceKeys(web: string): string[] {
  return [...web.matchAll(/https?:\/\/[^\s<>"',;]+/gi)].flatMap(([value]) => {
    try {
      const eh = parseEhentaiGalleryUrl(value);
      if (eh) return [`ehentai:${eh.canonicalId}`];
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

// Bracketed annotation groups doujin titles wrap around the work's name:
// "(C97) [Circle (Artist)] Title (Parody) [English] [Decensored]".
const ANNOTATION = String.raw`(?:\([^()]*\)|\[[^\[\]]*\]|\{[^{}]*\}|【[^【】]*】)`;
const LEADING_ANNOTATION = new RegExp(String.raw`^\s*${ANNOTATION}\s*`);
const TRAILING_ANNOTATION = new RegExp(String.raw`\s*(${ANNOTATION})\s*$`);
// A trailing annotation that may distinguish one part of a work from another
// ("(2)", "(Jou)"/"(Ge)", "[Zenpen]", "(Final)", "(II)") is kept, never stripped.
const PART_MARKER = /\d|[①-⑳]|^.\s*(?:[上中下続]|[前中後]編|[前中後]篇|完結編?|続編|総集編)\s*.$|chapter|volume|part|final|\b(?:ch|vol|ep|jou|chuu|ge|zenpen|chuuhen|kouhen|kanketsu|zoku|sequel|prequel|extra|omake|bonus|after|side|another|ex|[ivx]+)\b/i;

/** The work's own name with event, circle/artist, parody, language and release annotations removed. */
function coreTitle(raw: string): string {
  let title = raw.normalize('NFKC').trim();
  for (let match = LEADING_ANNOTATION.exec(title); match && match[0].length < title.length; match = LEADING_ANNOTATION.exec(title)) {
    title = title.slice(match[0].length);
  }
  for (let match = TRAILING_ANNOTATION.exec(title); match && match.index > 0 && !PART_MARKER.test(match[1]); match = TRAILING_ANNOTATION.exec(title)) {
    title = title.slice(0, match.index);
  }
  return title.trim();
}

/**
 * Looser title keys: annotation-free core titles (each side of a bilingual
 * "Japanese | English" title too) and titles too short for titleKeys. Only
 * trusted together with an exactly equal page count — see duplicateReasons.
 */
function coreTitleKeys(identity: GalleryIdentity): Set<string> {
  return new Set([identity.title, identity.titleAlt ?? ''].flatMap(title => {
    const variants = [title, ...title.split(/\s+\|\s+/).filter((_, __, parts) => parts.length > 1)];
    return variants.flatMap(variant => [normalize(variant), normalize(coreTitle(variant))]);
  }).filter(key => key.length >= 3));
}

/**
 * NFKC normalization and annotation stripping dominate a duplicate check, so
 * each identity's keys are derived once. Cached identities keep their object
 * across checks; the stored title guards against an identity being edited.
 */
interface TitleKeySets { title: string; titleAlt: string | undefined; exact: Set<string>; core: Set<string>; index: Set<string> }
const titleKeyMemo = new WeakMap<GalleryIdentity, TitleKeySets>();
function keySets(identity: GalleryIdentity): TitleKeySets {
  const hit = titleKeyMemo.get(identity);
  if (hit && hit.title === identity.title && hit.titleAlt === identity.titleAlt) return hit;
  const exact = titleKeys(identity), core = coreTitleKeys(identity);
  const sets = { title: identity.title, titleAlt: identity.titleAlt, exact, core, index: new Set([...exact, ...core]) };
  titleKeyMemo.set(identity, sets);
  return sets;
}

/** Every key a candidate may be found by; duplicateReasons decides which ones count. */
function indexTitleKeys(identity: GalleryIdentity): Set<string> {
  return keySets(identity).index;
}

const intersects = (a: Set<string>, b: Set<string>) => [...a].some(key => b.has(key));
function languageKey(value?: string | null): string {
  const key = normalize(value ?? '');
  const aliases: Record<string, string> = { en: 'english', eng: 'english', ja: 'japanese', jp: 'japanese', jpn: 'japanese', zh: 'chinese', zho: 'chinese', chi: 'chinese', ko: 'korean', kor: 'korean', de: 'german', deu: 'german', ger: 'german', fr: 'french', fra: 'french', fre: 'french', es: 'spanish', spa: 'spanish' };
  return ['unknown', 'und', 'none'].includes(key) ? '' : aliases[key] ?? key;
}

/** Conservative metadata evidence, never a claim of byte-identical content. */
export function duplicateReasons(a: GalleryIdentity, b: GalleryIdentity): string[] {
  const artists = new Set(b.artists.map(normalize).filter(Boolean));
  if (!a.artists.some(artist => artists.has(normalize(artist)))) return [];
  const languageA = languageKey(a.language), languageB = languageKey(b.language);
  if (languageA && languageB && languageA !== languageB) return [];
  if (a.pageCount && b.pageCount && a.pageCount !== b.pageCount) return [];
  const samePageCount = Boolean(a.pageCount && b.pageCount);
  // Exact titles stand on their own; a renamed or re-annotated title
  // ("(Mana) Ganyu" vs "Ganyu") also needs the identical page count.
  const keysA = keySets(a), keysB = keySets(b);
  if (!intersects(keysA.exact, keysB.exact) && !(samePageCount && intersects(keysA.core, keysB.core))) return [];
  return ['Same title', 'Same artist', ...(languageA && languageB ? ['Same language'] : []), ...(samePageCount ? ['Same page count'] : [])];
}

/** Censorship edition of a gallery, from its titles and any tag-stated edition. */
export function galleryEdition(identity: GalleryIdentity): CensorshipEdition {
  return censorshipEdition([identity.title, identity.titleAlt ?? ''], [...identity.tags ?? [], ...(identity.edition ? [identity.edition] : [])]);
}

function tagEdition(tags: readonly string[] | undefined): GalleryIdentity['edition'] {
  const edition = censorshipEdition([], tags ?? []);
  return edition === 'uncensored' || edition === 'censored' ? edition : undefined;
}

/** Label-free copies are memoized per identity so their title keys are derived once too. */
const strippedIdentities = new WeakMap<GalleryIdentity, { title: string; titleAlt: string | undefined; stripped: GalleryIdentity }>();
function withoutCensorship(identity: GalleryIdentity): GalleryIdentity {
  const hit = strippedIdentities.get(identity);
  if (hit && hit.title === identity.title && hit.titleAlt === identity.titleAlt && hit.stripped.pageCount === identity.pageCount) return hit.stripped;
  const stripped = { ...identity, title: withoutCensorshipLabels(identity.title), titleAlt: identity.titleAlt === undefined ? undefined : withoutCensorshipLabels(identity.titleAlt) };
  strippedIdentities.set(identity, { title: identity.title, titleAlt: identity.titleAlt, stripped });
  return stripped;
}

/**
 * The checked gallery is an uncensored or decensored edition of an owned copy
 * that is censored or not marked either way. Same work, artist and language;
 * release labels are ignored for the title, and a decensored release may add
 * or drop a few credit pages. Never a claim about image content.
 */
export function betterEditionReasons(incoming: GalleryIdentity, owned: GalleryIdentity): string[] {
  if (galleryEdition(incoming) !== 'uncensored') return [];
  const ownedEdition = galleryEdition(owned);
  if (ownedEdition !== 'censored' && ownedEdition !== 'unmarked') return [];
  const artists = new Set(owned.artists.map(normalize).filter(Boolean));
  if (!incoming.artists.some(artist => artists.has(normalize(artist)))) return [];
  const languageA = languageKey(incoming.language), languageB = languageKey(owned.language);
  if (languageA && languageB && languageA !== languageB) return [];
  const a = withoutCensorship(incoming), b = withoutCensorship(owned);
  const pageGap = a.pageCount && b.pageCount ? Math.abs(a.pageCount - b.pageCount) : null;
  if (pageGap !== null && pageGap > Math.max(2, Math.round(Math.max(a.pageCount!, b.pageCount!) * 0.1))) return [];
  const keysA = keySets(a), keysB = keySets(b);
  if (!intersects(keysA.exact, keysB.exact) && !(pageGap === 0 && intersects(keysA.core, keysB.core))) return [];
  return ['Same title', 'Same artist', ...(languageA && languageB ? ['Same language'] : []),
    ownedEdition === 'censored' ? 'Your copy is the censored edition' : 'Your copy is not marked uncensored'];
}

const storeKey = (identity: GalleryIdentity) => identity.path ? `duplicate-file:${identity.path}` : `duplicate-gallery:${identity.source}:${identity.galleryId}`;
const galleryKey = (identity: { source: string; galleryId: string }) => `${identity.source}:${identity.galleryId}`;
const ACTIVE_TASK_STATUSES = ['completed', 'queued', 'downloading', 'paused'];

export function recordGalleryIdentity(gallery: DoujinGallery): GalleryIdentity {
  const edition = tagEdition(gallery.tags);
  const identity: GalleryIdentity = { source: gallery.source, galleryId: gallery.galleryId, title: gallery.title, titleAlt: gallery.titleAlt, artists: gallery.artists ?? [], language: gallery.language, pageCount: gallery.pages.length || gallery.pageCount, ...(edition ? { edition } : {}) };
  saveIdentity(identity);
  return identity;
}

/* ---------------------------------------------------------------------------
 * In-memory index of the stored `duplicate-*` identities.
 *
 * Every write in this module (saveIdentity, scan pruning) updates the index in
 * place. A cheap index-only row count catches inserts and deletes made outside
 * this module, and invalidateDuplicateLibrary() forces a reload. A reload
 * reuses the previous object for every unchanged row, so JSON parsing and
 * title-key normalization only run for rows that actually changed.
 * ------------------------------------------------------------------------- */
const DUPLICATE_KEY_RANGE = and(gte(schema.keyValueStore.key, 'duplicate-'), lt(schema.keyValueStore.key, 'duplicate.'));
interface StoredEntry { json: string; identity: GalleryIdentity }
interface StoredIndex {
  rowCount: number;
  entries: Map<string, StoredEntry>;
  rowKeys: WeakMap<GalleryIdentity, string>;
  byTitle: Map<string, Set<GalleryIdentity>>;
  bySourceKey: Map<string, Set<GalleryIdentity>>;
  byGallery: Map<string, Set<GalleryIdentity>>;
  byStoreKey: Map<string, Set<GalleryIdentity>>;
}
let storedIndex: StoredIndex | null = null;
let storedStale = true;

function bucketAdd(map: Map<string, Set<GalleryIdentity>>, key: string, identity: GalleryIdentity): void {
  const bucket = map.get(key);
  if (bucket) bucket.add(identity);
  else map.set(key, new Set([identity]));
}
function bucketDelete(map: Map<string, Set<GalleryIdentity>>, key: string, identity: GalleryIdentity): void {
  const bucket = map.get(key);
  if (bucket?.delete(identity) && !bucket.size) map.delete(key);
}
function indexEntry(index: StoredIndex, rowKey: string, entry: StoredEntry, add: boolean): void {
  const { identity } = entry;
  const apply = add ? bucketAdd : bucketDelete;
  for (const title of indexTitleKeys(identity)) apply(index.byTitle, title, identity);
  for (const key of identity.sourceKeys ?? []) apply(index.bySourceKey, key, identity);
  apply(index.byGallery, galleryKey(identity), identity);
  apply(index.byStoreKey, storeKey(identity), identity);
  if (add) { index.entries.set(rowKey, entry); index.rowKeys.set(identity, rowKey); }
  else index.entries.delete(rowKey);
}
const storedRowCount = (): number => getDb().select({ n: sql<number>`count(*)` }).from(schema.keyValueStore).where(DUPLICATE_KEY_RANGE).get()?.n ?? 0;
function loadStoredIndex(previous: StoredIndex | null): StoredIndex {
  const rows = getDb().select({ key: schema.keyValueStore.key, valueJson: schema.keyValueStore.valueJson })
    .from(schema.keyValueStore).where(DUPLICATE_KEY_RANGE).all();
  const index: StoredIndex = { rowCount: rows.length, entries: new Map(), rowKeys: new WeakMap(), byTitle: new Map(), bySourceKey: new Map(), byGallery: new Map(), byStoreKey: new Map() };
  for (const row of rows) {
    const reused = previous?.entries.get(row.key);
    if (reused && reused.json === row.valueJson) { indexEntry(index, row.key, reused, true); continue; }
    try { indexEntry(index, row.key, { json: row.valueJson, identity: JSON.parse(row.valueJson) as GalleryIdentity }, true); }
    catch { /* an unreadable row never matches */ }
  }
  return index;
}
/** The current stored identities, refreshed only when they may have changed. */
function getStoredIndex(): StoredIndex {
  if (!storedIndex || storedStale || storedIndex.rowCount !== storedRowCount()) {
    storedIndex = loadStoredIndex(storedIndex);
    storedStale = false;
  }
  return storedIndex;
}
/** Stored identities in SQLite key order, which is the order matches are reported in. */
function inKeyOrder(index: StoredIndex, identities: Iterable<GalleryIdentity>): GalleryIdentity[] {
  return [...identities].sort((a, b) => {
    const ka = index.rowKeys.get(a) ?? '', kb = index.rowKeys.get(b) ?? '';
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Gallery identities recorded recently; orphan pruning leaves them for the enqueue that follows. */
const recentlyRecorded = new Map<string, number>();
const RECENT_IDENTITY_MS = 60 * 60_000;
function noteRecorded(key: string): void {
  recentlyRecorded.delete(key);
  recentlyRecorded.set(key, Date.now());
  while (recentlyRecorded.size > 5000) recentlyRecorded.delete(recentlyRecorded.keys().next().value!);
}

function saveIdentity(identity: GalleryIdentity): void {
  const key = storeKey(identity);
  const valueJson = JSON.stringify(identity);
  if (!identity.path) noteRecorded(key);
  // A loaded index is current for this module's own writes; skipping the row
  // count here keeps a large library scan from re-counting once per archive.
  const index = storedIndex && !storedStale ? storedIndex : getStoredIndex();
  const previous = index.entries.get(key);
  // Re-previewing a gallery usually yields identical metadata: skip the write.
  if (previous?.json === valueJson) return;
  getDb().insert(schema.keyValueStore).values({ key, valueJson }).onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson } }).run();
  if (previous) indexEntry(index, key, previous, false);
  // A row that existed but could not be parsed is not in `entries`; the next
  // count check then disagrees and reloads, which is always safe.
  else index.rowCount++;
  indexEntry(index, key, { json: valueJson, identity: JSON.parse(valueJson) as GalleryIdentity }, true);
}
function deleteStoredRows(keys: string[]): void {
  if (!keys.length) return;
  const index = getStoredIndex();
  const db = getDb();
  db.transaction(() => {
    for (let i = 0; i < keys.length; i += 500) db.delete(schema.keyValueStore).where(inArray(schema.keyValueStore.key, keys.slice(i, i + 500))).run();
  });
  for (const key of keys) {
    const entry = index.entries.get(key);
    if (entry) { indexEntry(index, key, entry, false); index.rowCount--; }
  }
}

let scan: Promise<void> | null = null;
let scannedAt = 0;
let rootsKey = '';
let availableFiles = new Set<string>();
let warnings: string[] = [];
/** Library contents or stored identities changed: rescan (within the cache window) and reload. */
export function invalidateDuplicateLibrary(): void { scannedAt = 0; storedStale = true; }

/** Learn folders from normal library browsing; downloading never waits for Kavita. */
export function rememberDuplicateLibraryRoots(libraries: KavitaLibrary[]): void {
  const valueJson = JSON.stringify({ baseUrl: getKavitaConnection().baseUrl, paths: libraries.flatMap(library => library.paths ?? (library.path ? [library.path] : [])) });
  const db = getDb();
  const existing = db.select({ valueJson: schema.keyValueStore.valueJson }).from(schema.keyValueStore).where(eq(schema.keyValueStore.key, 'library-duplicate-roots')).get();
  if (existing?.valueJson === valueJson) return;
  db.insert(schema.keyValueStore).values({ key: 'library-duplicate-roots', valueJson }).onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson } }).run();
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
    // Folders that could not be listed: their archives may still exist, so
    // their cached identities are kept rather than pruned.
    const unreadable: string[] = [];
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
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { problems.push(`Could not check folder: ${absolute}`); unreadable.push(absolute); }
        else if (absolute !== path.resolve(settings.downloadDirectory || '.')) { problems.push(`Library folder unavailable: ${absolute}`); unreadable.push(absolute); }
      }
    }
    for (const root of new Set(roots)) await walk(root);
    // Pick up rows written outside this module since the last check.
    storedStale = true;
    const previous = new Map<string, GalleryIdentity>();
    for (const { identity } of getStoredIndex().entries.values()) if (identity.path) previous.set(identity.path, identity);
    const updatedIdentities: GalleryIdentity[] = [];
    await mapLimit([...files], 6, async file => {
      try {
        const stat = await fs.promises.stat(file);
        // v5 also reads the censorship edition stated by ComicInfo Tags.
        const stamp = `v5:${stat.mtimeMs}:${stat.size}`;
        if (previous.get(file)?.stamp === stamp) return;
        const { xml: raw, imageCount: count } = await readComicInfoAndImageCount(file);
        if (!raw) { missingMetadata++; files.delete(file); return; }
        const fields = parseComicInfo(raw).fields;
        const artists = `${fields.Artist ?? ''},${fields.Writer ?? ''}`.split(/[,;]/).map(artist => artist.trim()).filter(Boolean);
        const title = fields.Title?.trim() || fields.Series?.trim() || '';
        const baseName = path.basename(file);
        const filenameKey = baseName.match(/\[(hitomi|nhentai)-(\d+)\]\.cbz$/i);
        const ehFilenameKey = baseName.match(/\[ehentai-([1-9]\d{0,9}-[0-9a-f]{10,12})\]\.cbz$/i);
        const parsedEhId = ehFilenameKey ? parseEhentaiGalleryId(ehFilenameKey[1]) : null;
        const keys = [...new Set([
          ...sourceKeys(fields.Web ?? ''),
          ...(filenameKey ? [`${filenameKey[1].toLowerCase()}:${filenameKey[2]}`] : []),
          ...(parsedEhId ? [`ehentai:${parsedEhId.canonicalId}`] : []),
        ])];
        if ((!title || !artists.length) && !keys.length) { missingMetadata++; files.delete(file); return; }
        const originalFilename = baseName
          .replace(/\.cbz$/i, '')
          .replace(/\s*\[(?:(?:hitomi|nhentai)-\d+|ehentai-[1-9]\d{0,9}-[0-9a-f]{10,12})\]$/i, '')
          .trim();
        const edition = tagEdition((fields.Tags ?? '').split(','));
        updatedIdentities.push({ source: 'library', galleryId: file, path: file, title: title || originalFilename, titleAlt: originalFilename, artists, language: fields.LanguageISO || fields.Language, pageCount: count, stamp, sourceKeys: keys, ...(edition ? { edition } : {}) });
      } catch { files.delete(file); problems.push(`Could not read archive metadata: ${file}`); }
    });
    if (updatedIdentities.length) {
      getDb().transaction(() => {
        for (const identity of updatedIdentities) saveIdentity(identity);
      });
    }
    pruneStoredIdentities(files, unreadable);
    availableFiles = files;
    if (missingMetadata) problems.push(`${missingMetadata} archive${missingMetadata === 1 ? '' : 's'} missing title or artist metadata could not be compared.`);
    warnings = problems.length > 10 ? [...problems.slice(0, 10), `${problems.length - 10} additional archive or folder warnings.`] : problems;
    rootsKey = key;
    scannedAt = Date.now();
  })();
  try { await scan; } finally { scan = null; }
}

/**
 * Drop identities that can never match again: archives that are gone (or no
 * longer comparable) from every folder that could be listed, and gallery
 * identities no download task or ownership refers to. Those are re-recorded
 * whenever the gallery is previewed or checked again.
 */
function pruneStoredIdentities(comparableFiles: Set<string>, unreadable: string[]): void {
  const db = getDb();
  const referenced = new Set(db.selectDistinct({ source: schema.downloadQueue.source, galleryId: schema.downloadQueue.galleryId }).from(schema.downloadQueue).all().map(galleryKey));
  for (const row of db.select({ source: schema.ownedGalleries.source, galleryId: schema.ownedGalleries.galleryId }).from(schema.ownedGalleries).all()) referenced.add(galleryKey(row));
  const now = Date.now();
  for (const [key, at] of recentlyRecorded) { if (now - at <= RECENT_IDENTITY_MS) break; recentlyRecorded.delete(key); }
  const insideUnreadable = (file: string) => unreadable.some(dir => file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep));
  const stale: string[] = [];
  for (const [rowKey, { identity }] of getStoredIndex().entries) {
    if (identity.path) {
      if (rowKey === storeKey(identity) && !comparableFiles.has(identity.path) && !insideUnreadable(identity.path)) stale.push(rowKey);
    } else if (rowKey === storeKey(identity) && !referenced.has(galleryKey(identity)) && !recentlyRecorded.has(rowKey)) {
      stale.push(rowKey);
    }
  }
  deleteStoredRows(stale);
}

export async function prepareDuplicateCheck(items: { source: DoujinSource; galleryId: string; url?: string }[], refresh = false): Promise<GalleryIdentity[]> {
  if (refresh) invalidateDuplicateLibrary();
  const identities = await mapLimit(items, 3, async item => {
    const gallery = await resolveDuplicateGallery(item.source, item.url ?? item.galleryId);
    return recordGalleryIdentity(gallery);
  });
  await scanLibrary();
  return identities;
}

/** The owned copy each gallery improves on, when every library match is an earlier edition. */
export interface BetterEditionOf { title: string; path?: string; source: string; galleryId: string }

/** Better-edition verdicts for galleries already described by search metadata (no provider fetches). */
export async function findBetterEditions(items: GalleryIdentity[]): Promise<Map<string, BetterEditionOf>> {
  const out = new Map<string, BetterEditionOf>();
  if (!items.length) return out;
  await scanLibrary();
  for (const report of findDuplicateReports(items, [], true).reports) {
    if (!report.matches.length || !report.matches.every(match => match.betterEdition)) continue;
    const owned = report.matches[0];
    out.set(`${report.source}:${report.galleryId}`, { title: owned.title, source: owned.source, galleryId: owned.galleryId, ...(owned.path ? { path: owned.path } : {}) });
  }
  return out;
}

/** Search results already contain enough metadata; never fetch provider pages for a card badge. */
export async function lookupLibraryMatches(items: GalleryIdentity[]) {
  await scanLibrary();
  return findDuplicateReports(items, [], true);
}

/** Older galleries' tag profiles, reused across checks while their row is unchanged. */
interface TagProfile { title: string | null; artistsJson: string; language: string | null; identity: GalleryIdentity | null }
let tagProfiles = new Map<string, TagProfile>();
function tagIdentities(): { key: string; identity: GalleryIdentity }[] {
  const next = new Map<string, TagProfile>();
  const out: { key: string; identity: GalleryIdentity }[] = [];
  for (const row of getDb().select({
    source: schema.galleryTags.source,
    galleryId: schema.galleryTags.galleryId,
    title: schema.galleryTags.title,
    artistsJson: schema.galleryTags.artistsJson,
    language: schema.galleryTags.language,
  }).from(schema.galleryTags).all()) {
    const key = galleryKey(row);
    let profile = tagProfiles.get(key);
    if (!profile || profile.title !== row.title || profile.artistsJson !== row.artistsJson || profile.language !== row.language) {
      let identity: GalleryIdentity | null = { source: row.source, galleryId: row.galleryId, title: row.title ?? '', artists: [], language: row.language };
      try { identity.artists = JSON.parse(row.artistsJson); } catch { identity = null; }
      profile = { title: row.title, artistsJson: row.artistsJson, language: row.language, identity };
    }
    next.set(key, profile);
    if (profile.identity) out.push({ key, identity: profile.identity });
  }
  tagProfiles = next;
  return out;
}

interface TaskRef { id: number; status: string; outputPath: string | null }
export interface DuplicateChecker {
  /** Same result as findDuplicateReports(incoming, excludedPaths) against the checker's snapshot. */
  check(incoming: GalleryIdentity[]): { reports: DuplicateReport[]; warnings: string[] };
  /** Record a task enqueued after the snapshot (by id), so later checks see it as a fresh check would. */
  noteQueued(identity: GalleryIdentity, taskId: number): void;
}

/**
 * Build the candidate set (stored identities, ownership, active tasks and tag
 * profiles) once. A batch that checks and enqueues items one at a time shares
 * one checker instead of reloading everything per item.
 */
export function createDuplicateChecker(excludedPaths: string[] = []): DuplicateChecker {
  return buildChecker(excludedPaths, false, []);
}

function buildChecker(excludedPaths: string[], includeOwned: boolean, ownedIncoming: GalleryIdentity[]): DuplicateChecker {
  const db = getDb();
  const tasksByGallery = new Map<string, TaskRef>(db.select({
    id: schema.downloadQueue.id,
    source: schema.downloadQueue.source,
    galleryId: schema.downloadQueue.galleryId,
    status: schema.downloadQueue.status,
    outputPath: schema.downloadQueue.outputPath,
  }).from(schema.downloadQueue).where(inArray(schema.downloadQueue.status, ACTIVE_TASK_STATUSES)).all().map(task => [galleryKey(task), task]));
  const owned = new Set(db.select({ source: schema.ownedGalleries.source, galleryId: schema.ownedGalleries.galleryId }).from(schema.ownedGalleries).all().map(galleryKey));
  const excluded = new Set(excludedPaths.map(file => path.resolve(file)));
  const index = getStoredIndex();
  const tracked = (key: string) => owned.has(key) || tasksByGallery.has(key);
  const eligible = (candidate: GalleryIdentity) => candidate.path ? availableFiles.has(candidate.path) && !excluded.has(candidate.path) : tracked(galleryKey(candidate));
  const known = (key: string) => [...index.byStoreKey.get(key) ?? []].some(eligible);
  // Older downloads already have title/artist/language profiles; no provider backfill is needed.
  const extras: GalleryIdentity[] = [];
  if (includeOwned) for (const item of ownedIncoming) {
    if (tracked(galleryKey(item)) && !known(storeKey(item))) extras.push({ ...item });
  }
  const tags: GalleryIdentity[] = [];
  for (const { key, identity } of tagIdentities()) {
    if (tracked(key) && !known(`duplicate-gallery:${key}`)) tags.push(identity);
  }
  // Extras and tag profiles are few or cheap to index per check; stored
  // identities use the shared index and are filtered by eligibility on read.
  const local = new Map<string, GalleryIdentity[]>();
  const localDirect = new Map<string, GalleryIdentity[]>();
  const push = (map: Map<string, GalleryIdentity[]>, key: string, identity: GalleryIdentity) => {
    const list = map.get(key);
    if (list) list.push(identity);
    else map.set(key, [identity]);
  };
  for (const candidate of [...extras, ...tags]) {
    for (const title of indexTitleKeys(candidate)) push(local, title, candidate);
    for (const key of candidate.sourceKeys ?? []) push(localDirect, key, candidate);
    if (includeOwned) push(localDirect, galleryKey(candidate), candidate);
  }
  const existsCache = new Map<string, boolean>();
  const pathExists = (filePath: string): boolean => {
    let hit = existsCache.get(filePath);
    if (hit === undefined) { hit = fs.existsSync(filePath); existsCache.set(filePath, hit); }
    return hit;
  };

  const check = (incoming: GalleryIdentity[]) => {
    const incomingSet = new Set(incoming);
    const incomingByTitle = new Map<string, GalleryIdentity[]>();
    if (!includeOwned) for (const item of incoming) for (const title of indexTitleKeys(item)) push(incomingByTitle, title, item);
    return { reports: incoming.map(item => {
      const matches: DuplicateMatch[] = [];
      const seen = new Set<string>();
      const itemKey = galleryKey(item);
      // Candidate order matches a full scan: stored rows by key, then the
      // checked items' own owned profiles, tag profiles, and the selection.
      const titleMatches = new Set<GalleryIdentity>();
      for (const title of indexTitleKeys(item)) {
        const bucket = index.byTitle.get(title);
        if (bucket) for (const candidate of inKeyOrder(index, [...bucket].filter(eligible))) titleMatches.add(candidate);
        for (const candidate of local.get(title) ?? []) titleMatches.add(candidate);
        for (const candidate of incomingByTitle.get(title) ?? []) titleMatches.add(candidate);
      }
      const direct = new Set([...index.bySourceKey.get(itemKey) ?? [], ...(includeOwned ? index.byGallery.get(itemKey) ?? [] : [])]);
      for (const candidate of inKeyOrder(index, [...direct].filter(eligible))) titleMatches.add(candidate);
      for (const candidate of localDirect.get(itemKey) ?? []) titleMatches.add(candidate);
      for (const candidate of titleMatches) {
        const confirmed = !incomingSet.has(candidate) && (candidate.sourceKeys?.includes(itemKey) || (includeOwned && candidate.source === item.source && candidate.galleryId === item.galleryId));
        if (!confirmed && candidate.source === item.source && candidate.galleryId === item.galleryId) continue;
        // A decensored upload is usually a separate gallery on the same source, so
        // better editions are compared even where same-source duplicates are not.
        const better = confirmed || incomingSet.has(candidate) ? [] : betterEditionReasons(item, candidate);
        if (!confirmed && !better.length && !candidate.path && candidate.source === item.source) continue;
        const reasons = confirmed ? ['Same source gallery'] : better.length ? better : duplicateReasons(item, candidate);
        if (!reasons.length || seen.has(storeKey(candidate)) || (candidate.path && !pathExists(candidate.path))) continue;
        seen.add(storeKey(candidate));
        const task = tasksByGallery.get(galleryKey(candidate));
        matches.push({ title: candidate.title, source: candidate.source, galleryId: candidate.galleryId, artists: candidate.artists, language: candidate.language, pageCount: candidate.pageCount, path: candidate.path ?? task?.outputPath ?? undefined, taskId: task?.id, status: candidate.path ? 'In library' : task?.status ?? (owned.has(galleryKey(candidate)) ? 'Owned' : 'In selection'), reasons, confirmed: !!confirmed, ...(better.length ? { betterEdition: true } : {}) });
      }
      return { source: item.source as DoujinSource, galleryId: item.galleryId, title: item.title, matches };
    }), warnings: [...warnings] };
  };

  return {
    check,
    noteQueued(identity, taskId) {
      // The enqueued gallery's identity is already stored (prepareDuplicateCheck
      // recorded it); its task is what makes it a candidate. Enqueueing may
      // already have claimed the task, so read its current status.
      const task = db.select({ id: schema.downloadQueue.id, status: schema.downloadQueue.status, outputPath: schema.downloadQueue.outputPath })
        .from(schema.downloadQueue).where(eq(schema.downloadQueue.id, taskId)).get();
      if (task && ACTIVE_TASK_STATUSES.includes(task.status)) tasksByGallery.set(galleryKey(identity), task);
    },
  };
}

/** Synchronous check immediately before enqueue closes races with other requests. */
export function findDuplicateReports(incoming: GalleryIdentity[], excludedPaths: string[] = [], includeOwned = false): { reports: DuplicateReport[]; warnings: string[] } {
  return buildChecker(excludedPaths, includeOwned, incoming).check(incoming);
}

/**
 * Fast synchronous check against already-indexed local library archives and
 * cross-source download identities — never scans directories or contacts Kavita.
 */
export function findKnownLibraryDuplicateKeys(incoming: GalleryIdentity[]): Set<string> {
  if (!incoming.length) return new Set();
  const db = getDb();
  const index = getStoredIndex();
  if (!index.entries.size) return new Set();
  const owned = new Set(db.select({ source: schema.ownedGalleries.source, galleryId: schema.ownedGalleries.galleryId }).from(schema.ownedGalleries).all().map(galleryKey));
  const tasks = new Set(
    db.select({ source: schema.downloadQueue.source, galleryId: schema.downloadQueue.galleryId })
      .from(schema.downloadQueue).where(inArray(schema.downloadQueue.status, ACTIVE_TASK_STATUSES)).all()
      .map(galleryKey),
  );
  const eligible = (candidate: GalleryIdentity) => candidate.path ? true : owned.has(galleryKey(candidate)) || tasks.has(galleryKey(candidate));
  const existsCache = new Map<string, boolean>();
  const pathExists = (filePath: string): boolean => {
    let hit = existsCache.get(filePath);
    if (hit === undefined) { hit = fs.existsSync(filePath); existsCache.set(filePath, hit); }
    return hit;
  };
  const duplicates = new Set<string>();
  for (const item of incoming) {
    const key = galleryKey(item);
    const direct = [...index.bySourceKey.get(key) ?? []].filter(eligible);
    if (direct.some(candidate => !candidate.path || pathExists(candidate.path))) {
      duplicates.add(key);
      continue;
    }
    const titleCandidates = new Set<GalleryIdentity>();
    for (const title of indexTitleKeys(item)) for (const candidate of index.byTitle.get(title) ?? []) if (eligible(candidate)) titleCandidates.add(candidate);
    for (const candidate of titleCandidates) {
      if (!candidate.path && candidate.source === item.source && candidate.galleryId === item.galleryId) continue;
      // The metadata comparison is cheap in memory; only a real match costs a filesystem check.
      // A better edition of an owned copy is not a duplicate of it.
      if (duplicateReasons(item, candidate).length > 0 && !betterEditionReasons(item, candidate).length && (!candidate.path || pathExists(candidate.path))) {
        duplicates.add(key);
        break;
      }
    }
  }
  return duplicates;
}
