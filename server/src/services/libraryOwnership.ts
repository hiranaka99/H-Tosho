import { KavitaClient } from '../kavita/client.js';
import type { KavitaSeries, KavitaSeriesMetadataDto } from '../kavita/types.js';
import type { DoujinSearchResult } from '../downloader/types.js';
import { mapLimit } from '../lib/http.js';
import { getKavitaConnection, onSettingChange } from './settings.js';
import { onRecommendationSeriesChange } from './recommendationSignals.js';

export interface LibraryMatch {
  seriesId: number;
  libraryId: number;
  libraryName: string;
  name: string;
  reason: 'provider-id' | 'metadata';
}
interface Entry { series: KavitaSeries; libraryName: string; metadata?: KavitaSeriesMetadataDto }
interface OwnershipIndex { providerMatches: Map<string, LibraryMatch>; metadataMatches: Map<string, LibraryMatch> }
const TTL = 10 * 60_000;
let revision = 0;
let snapshot: ({ at: number; entries: Entry[]; complete: boolean; error: string | null } & OwnershipIndex) | null = null;
let inflight: Promise<void> | null = null;
let scanned = 0;
let total = 0;

export function invalidateLibraryOwnership(): void {
  revision++;
  snapshot = null;
  inflight = null;
}
onSettingChange('kavita-connection', invalidateLibraryOwnership);
onRecommendationSeriesChange(invalidateLibraryOwnership);

const normalize = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

/** Parse only recognized provider URLs, never substring-match arbitrary domains. */
export function galleryKeysFromLinks(links: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of links.match(/https?:\/\/[^\s,;<>"']+/gi) ?? []) {
    try {
      const url = new URL(raw);
      if (url.hostname === 'nhentai.net' || url.hostname === 'www.nhentai.net') {
        const id = /^\/g\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1];
        if (id) keys.add(`nhentai:${id}`);
      }
      if (url.hostname === 'hitomi.la' || url.hostname === 'www.hitomi.la') {
        const id = /^\/(?:galleries\/(\d+)\.html|(?:doujinshi|manga|artistcg|gamecg|imageset)\/[^/]*-(\d+)\.html)$/.exec(url.pathname);
        if (id) keys.add(`hitomi:${id[1] ?? id[2]}`);
      }
    } catch { /* malformed Web link */ }
  }
  return keys;
}

function metadataKey(title: string, artists: string[], pages: number | undefined, language: string | undefined): string | null {
  const people = [...new Set(artists.map(normalize).filter(Boolean))].sort();
  if (!title.trim() || !people.length || !pages || pages <= 0 || !Number.isFinite(pages) || !language?.trim()) return null;
  return JSON.stringify([normalize(title), people, pages, normalize(language)]);
}

function indexEntries(entries: Entry[]): OwnershipIndex {
  const providerMatches = new Map<string, LibraryMatch>();
  const metadataMatches = new Map<string, LibraryMatch>();
  for (const { series, libraryName, metadata } of entries) {
    const folder = (series.folderPath ?? '').replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '';
    const embeddedId = /\[(hitomi|nhentai)-(\d+)\]$/.exec(folder)?.slice(1).join(':');
    const linked = galleryKeysFromLinks(metadata?.webLinks ?? '');
    if (embeddedId) linked.add(embeddedId);
    const match = { seriesId: series.id, libraryId: series.libraryId, libraryName, name: series.name };
    for (const key of linked) if (!providerMatches.has(key)) providerMatches.set(key, { ...match, reason: 'provider-id' });
    // A title alone is never sufficient. Keep language editions and similarly
    // named works distinct, and avoid matching a gallery against a merged series.
    if (metadata) {
      const artists = [...(metadata.pencillers ?? []), ...(metadata.inkers ?? []), ...(metadata.writers ?? [])].map(p => p.name ?? '');
      const key = metadataKey(series.name, artists, series.pages, metadata.language ?? undefined);
      if (key && !metadataMatches.has(key)) metadataMatches.set(key, { ...match, reason: 'metadata' });
    }
  }
  return { providerMatches, metadataMatches };
}

function matchIndex(item: DoujinSearchResult, index: OwnershipIndex): LibraryMatch | null {
  const explicit = index.providerMatches.get(`${item.source}:${item.galleryId}`);
  if (explicit) return explicit;
  const key = metadataKey(item.title, item.artists, item.pageCount, item.language);
  return key ? index.metadataMatches.get(key) ?? null : null;
}

export function matchLibraryGallery(item: DoujinSearchResult, entries: Entry[]): LibraryMatch | null {
  return matchIndex(item, indexEntries(entries));
}

/** Coalesced, bounded-concurrency scan of ALL libraries, not the sampled taste profile. */
async function ensureIndex(): Promise<void> {
  const conn = getKavitaConnection();
  if (!conn.baseUrl || !conn.apiKey) return;
  if (snapshot && Date.now() - snapshot.at < (snapshot.complete ? TTL : 30_000)) return;
  if (inflight) return inflight;
  const currentRevision = revision;
  const previous = snapshot;
  scanned = 0; total = 0;
  const run = (async () => {
    const client = new KavitaClient(conn.baseUrl, conn.apiKey);
    let complete = true;
    try {
      const libraries = await client.getLibraries();
      const lists = await mapLimit(libraries, 4, async library => {
        try { return (await client.getSeries(library.id)).map(series => ({ series, libraryName: library.name })); }
        catch { complete = false; return previous?.entries.filter(e => e.series.libraryId === library.id) ?? []; }
      });
      const listed = lists.flat();
      if (revision === currentRevision) total = listed.length;
      const entries = await mapLimit(listed, 8, async entry => {
        let metadata: KavitaSeriesMetadataDto | undefined;
        try { metadata = await client.getSeriesMetadata(entry.series.id); }
        catch (error) {
          // A series can legitimately have no metadata row yet.
          if (!/HTTP 404\b/.test(error instanceof Error ? error.message : '')) complete = false;
          metadata = previous?.entries.find(e => e.series.id === entry.series.id)?.metadata;
        }
        if (revision === currentRevision) scanned++;
        return { ...entry, metadata };
      });
      if (revision === currentRevision) snapshot = { at: Date.now(), entries, ...indexEntries(entries), complete, error: complete ? null : 'Some Kavita libraries or metadata could not be checked.' };
    } catch {
      if (revision === currentRevision) snapshot = { at: Date.now(), entries: previous?.entries ?? [], ...indexEntries(previous?.entries ?? []), complete: false, error: 'Kavita is unavailable. Check the connection in Settings.' };
    }
  })().finally(() => { if (inflight === run) inflight = null; });
  inflight = run;
  await run;
  // Never publish ownership from a previous connection or invalidated scan.
  if (revision !== currentRevision) await ensureIndex();
}

export function libraryOwnershipStatus() {
  const conn = getKavitaConnection();
  return { configured: Boolean(conn.baseUrl && conn.apiKey), checking: Boolean(inflight), complete: snapshot?.complete ?? false,
    checkedAt: snapshot ? new Date(snapshot.at).toISOString() : null, scanned, total, error: snapshot?.error ?? null };
}

export async function libraryMatches(items: DoujinSearchResult[]): Promise<Map<string, LibraryMatch>> {
  if (!items.length) return new Map();
  await ensureIndex();
  return new Map(items.flatMap(item => {
    const match = snapshot ? matchIndex(item, snapshot) : null;
    return match ? [[`${item.source}:${item.galleryId}`, match] as const] : [];
  }));
}

export async function annotateLibraryOwnership<T extends DoujinSearchResult>(items: T[]): Promise<(T & { libraryMatch?: LibraryMatch })[]> {
  const matches = await libraryMatches(items);
  return items.map(item => ({ ...item, libraryMatch: matches.get(`${item.source}:${item.galleryId}`) }));
}

export async function refreshLibraryOwnership(): Promise<void> {
  invalidateLibraryOwnership();
  await ensureIndex();
}
