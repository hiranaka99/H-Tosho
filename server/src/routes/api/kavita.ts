import { rememberDuplicateLibraryRoots } from '../../services/galleryDuplicates.js';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { eq, inArray } from 'drizzle-orm';
import { libraryMutations } from '../../lib/mutations.js';
import { jobQueue } from '../../jobs/queue.js';
import { downloadQueue } from '../../downloader/engine.js';
import { kavitaConnectionKey } from '../../services/kavitaState.js';
import { getDb, schema } from '../../db/index.js';
import { KavitaClient } from '../../kavita/client.js';
import { KAVITA_OPENAPI_VERSION } from '../../kavita/types.js';
import { getKavitaConnection, onSettingChange, setKavitaConnection } from '../../services/settings.js';
import { kavitaSeriesSearchMetadata } from '../../services/seriesArtists.js';
import {
  getSeriesCoverEntry,
  invalidateSeriesCoverCache,
  seriesCoverInflight,
  setSeriesCoverEntry,
  type CachedSeriesCover,
} from '../../services/seriesCoverCache.js';

import { connectedClient, errMsg, intParam, kavitaCoverUrl } from './helpers.js';
export { invalidateSeriesCoverCache };
export const api = new Hono();

// A large library's series list is megabytes of repetitive JSON; gzip shrinks it ~90%.
// app.ts also compresses /api/*, but compress() skips already-encoded responses, and
// this keeps the router compressed when mounted on its own.
api.use('/kavita/libraries/:id/series', compress());

/**
 * Artists/tags parsed from a match row's metadataJson, keyed by Kavita series id
 * and stamped with the row id plus lastSyncedAt (every metadata write goes through
 * upsertMatch, which refreshes lastSyncedAt; delete + reinsert changes the row id).
 * Polls then skip loading and re-parsing multi-KB blobs for unchanged rows.
 */
const MATCH_META_CACHE_MAX = 50_000;
const matchMetaCache = new Map<number, { stamp: string; artists: string[]; tags: string[] }>();

onSettingChange('kavita-connection', () => {
  matchMetaCache.clear();
  invalidateSeriesCoverCache();
});

function etagMatches(header: string | undefined, tag: string): boolean {
  if (!header) return false;
  const bare = tag.replace(/^W\//, '');
  return header.split(',').some((candidate) => {
    const value = candidate.trim();
    return value === '*' || value.replace(/^W\//, '') === bare;
  });
}

const stringList = (values: unknown): string[] =>
  Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string' && v.trim().length > 0) : [];

function parseMatchMeta(metadataJson: string | null): { artists: string[]; tags: string[] } {
  if (!metadataJson) return { artists: [], tags: [] };
  try {
    const raw = JSON.parse(metadataJson) as unknown;
    if (raw && typeof raw === 'object') {
      const meta = raw as { artists?: unknown; tags?: unknown };
      return { artists: stringList(meta.artists), tags: stringList(meta.tags) };
    }
  } catch { /* ignore malformed metadata */ }
  return { artists: [], tags: [] };
}

function rememberMatchMeta(seriesId: number, entry: { stamp: string; artists: string[]; tags: string[] }): void {
  matchMetaCache.delete(seriesId);
  matchMetaCache.set(seriesId, entry);
  while (matchMetaCache.size > MATCH_META_CACHE_MAX) {
    const oldest = matchMetaCache.keys().next().value;
    if (oldest === undefined) break;
    matchMetaCache.delete(oldest);
  }
}

/** Snapshot of the connection that was replaced by a save whose test failed. */
const KAVITA_PREVIOUS_KEY = 'kavita-previous';
const SERVER_SWITCH_BUSY = 'Finish or cancel active library jobs and downloads before changing Kavita servers.';

/** Switching servers mid-run would point in-flight jobs at another library. */
function serverSwitchBlocked(nextBaseUrl: string): boolean {
  return kavitaConnectionKey(nextBaseUrl) !== kavitaConnectionKey(getKavitaConnection().baseUrl)
    && (libraryMutations.isBusy('*') || downloadQueue.activeCount() > 0 || jobQueue.active().some(job => job.type !== 'check-watched-searches'));
}
api.get('/kavita/status', async (c) => {
  const conn = getKavitaConnection();
  // The API key itself is never returned; the UI only needs to know it exists.
  if (!conn.baseUrl || !conn.apiKey) return c.json({ configured: false, baseUrl: conn.baseUrl, hasApiKey: Boolean(conn.apiKey) });
  try {
    const info = await new KavitaClient(conn.baseUrl, conn.apiKey).testConnection();
    return c.json({ configured: true, baseUrl: conn.baseUrl, hasApiKey: true, version: info.version, apiVersion: KAVITA_OPENAPI_VERSION, error: null });
  } catch (e) {
    return c.json({ configured: true, baseUrl: conn.baseUrl, hasApiKey: true, version: null, apiVersion: KAVITA_OPENAPI_VERSION, error: errMsg(e) });
  }
});

/** Tests candidate values without persisting them, so a working connection is never replaced by a failed guess. */
api.post('/kavita/connection/test', async (c) => {
  const raw: unknown = await c.req.json().catch(() => null);
  const body = (raw && typeof raw === 'object' ? raw : {}) as { baseUrl?: string; apiKey?: string };
  const saved = getKavitaConnection();
  const baseUrl = body.baseUrl?.trim() || saved.baseUrl;
  if (!baseUrl) return c.json({ connected: false, test: 'Enter a server address first.' });
  // A blank key reuses the stored one only when the address matches the saved server.
  const apiKey = body.apiKey?.trim() || (kavitaConnectionKey(baseUrl) === kavitaConnectionKey(saved.baseUrl) ? saved.apiKey : '');
  if (!apiKey) return c.json({ connected: false, test: 'Enter an Auth Key for this server address.' });
  try {
    const info = await new KavitaClient(baseUrl, apiKey).testConnection();
    return c.json({ connected: true, test: `Connected (Kavita ${info.version})` });
  } catch (e) {
    return c.json({ connected: false, test: errMsg(e) });
  }
});

api.post('/kavita/connection', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { baseUrl?: unknown; apiKey?: unknown } | null;
  if (typeof body?.baseUrl !== 'string' || !body.baseUrl.trim()) return c.json({ error: 'baseUrl is required' }, 400);
  if (body.apiKey !== undefined && typeof body.apiKey !== 'string') return c.json({ error: 'apiKey must be a string' }, 400);
  const baseUrl = body.baseUrl;
  const previous = getKavitaConnection();
  // A blank key keeps the stored one, so the UI can change the URL without
  // re-entering the secret (the server never returns it).
  const apiKey = body.apiKey?.trim() ? body.apiKey.trim() : previous.apiKey;
  if (!apiKey) return c.json({ error: 'apiKey is required' }, 400);
  if (serverSwitchBlocked(baseUrl)) return c.json({ error: SERVER_SWITCH_BUSY }, 409);
  setKavitaConnection({ baseUrl, apiKey });
  let test: string;
  let connected: boolean;
  try {
    const info = await new KavitaClient(baseUrl, apiKey).testConnection();
    test = `Connected (Kavita ${info.version})`;
    connected = true;
  } catch (e) {
    test = 'Saved, but connection test failed: ' + errMsg(e);
    connected = false;
  }
  // A failed test keeps the previous connection restorable; the key never leaves the server.
  const db = getDb();
  const canRestore = !connected && Boolean(previous.baseUrl && previous.apiKey);
  if (canRestore) {
    const snapshot = JSON.stringify({ baseUrl: previous.baseUrl, apiKey: previous.apiKey });
    db.insert(schema.keyValueStore).values({ key: KAVITA_PREVIOUS_KEY, valueJson: snapshot })
      .onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson: snapshot } }).run();
  } else {
    db.delete(schema.keyValueStore).where(eq(schema.keyValueStore.key, KAVITA_PREVIOUS_KEY)).run();
  }
  return c.json({ saved: true, connected, test, canRestore });
});

api.post('/kavita/connection/restore', (c) => {
  const db = getDb();
  const row = db.select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, KAVITA_PREVIOUS_KEY)).get();
  if (!row) return c.json({ error: 'No previous connection to restore.' }, 409);
  let snapshot: { baseUrl: string; apiKey: string } | null = null;
  try {
    const parsed = JSON.parse(row.valueJson) as { baseUrl?: unknown; apiKey?: unknown } | null;
    if (typeof parsed?.baseUrl === 'string' && parsed.baseUrl && typeof parsed.apiKey === 'string' && parsed.apiKey) snapshot = { baseUrl: parsed.baseUrl, apiKey: parsed.apiKey };
  } catch { /* handled below */ }
  if (!snapshot) {
    db.delete(schema.keyValueStore).where(eq(schema.keyValueStore.key, KAVITA_PREVIOUS_KEY)).run();
    return c.json({ error: 'The saved previous connection is unreadable; enter the server details again.' }, 409);
  }
  // Same rule as saving: never swap servers under running work. The snapshot
  // is kept so the restore can be retried once that work finishes.
  if (serverSwitchBlocked(snapshot.baseUrl)) return c.json({ error: SERVER_SWITCH_BUSY }, 409);
  db.delete(schema.keyValueStore).where(eq(schema.keyValueStore.key, KAVITA_PREVIOUS_KEY)).run();
  setKavitaConnection(snapshot);
  return c.json({ restored: true, baseUrl: snapshot.baseUrl });
});

api.get('/kavita/libraries', async (c) => {
  const client = connectedClient();
  if (!client) return c.json({ error: 'Kavita not configured' }, 503);
  try {
    const libs = await client.getLibraries();
    rememberDuplicateLibraryRoots(libs);
    // Library pickers only need names and paths. Per-library series counts used to
    // download every series of every library on each request; the series list
    // endpoint below loads one library when it is actually opened.
    return c.json(libs);
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

/** Stable until a successful sync, then changes so browsers decode the new cover. */
api.get('/kavita/libraries/:id/series', async (c) => {
  const client = connectedClient();
  if (!client) return c.json({ error: 'Kavita not configured' }, 503);
  try {
    const libraryId = intParam(c.req.param('id'));
    if (libraryId === null) return c.json({ error: 'Invalid library id' }, 400);
    const series = await client.getSeries(libraryId);
    const seriesIds = series.map((s) => s.id);
    const db = getDb();
    const matchColumns = {
      rowId: schema.seriesMatches.id,
      kavitaSeriesId: schema.seriesMatches.kavitaSeriesId,
      status: schema.seriesMatches.status,
      providerId: schema.seriesMatches.providerId,
      matchScore: schema.seriesMatches.matchScore,
      confirmed: schema.seriesMatches.confirmed,
      lastSyncedAt: schema.seriesMatches.lastSyncedAt,
      errorMessage: schema.seriesMatches.errorMessage,
    };
    const selectMatches = (ids: number[]) => db.select(matchColumns).from(schema.seriesMatches).where(inArray(schema.seriesMatches.kavitaSeriesId, ids)).all();
    const byId = new Map<number, { row: ReturnType<typeof selectMatches>[number]; meta: { artists: string[]; tags: string[] } }>();
    const misses: { seriesId: number; stamp: string }[] = [];
    for (let i = 0; i < seriesIds.length; i += 400) {
      for (const row of selectMatches(seriesIds.slice(i, i + 400))) {
        const stamp = `${row.rowId}:${row.lastSyncedAt ?? ''}`;
        const cached = matchMetaCache.get(row.kavitaSeriesId);
        if (cached?.stamp === stamp) {
          rememberMatchMeta(row.kavitaSeriesId, cached);
          byId.set(row.kavitaSeriesId, { row, meta: cached });
        } else {
          byId.set(row.kavitaSeriesId, { row, meta: { artists: [], tags: [] } });
          misses.push({ seriesId: row.kavitaSeriesId, stamp });
        }
      }
    }
    // Only changed or unseen rows load their metadata blob (same synchronous read, so no write can interleave).
    for (let i = 0; i < misses.length; i += 400) {
      const batch = misses.slice(i, i + 400);
      const blobs = new Map(db.select({ kavitaSeriesId: schema.seriesMatches.kavitaSeriesId, metadataJson: schema.seriesMatches.metadataJson })
        .from(schema.seriesMatches).where(inArray(schema.seriesMatches.kavitaSeriesId, batch.map((miss) => miss.seriesId))).all()
        .map((row) => [row.kavitaSeriesId, row.metadataJson]));
      for (const { seriesId, stamp } of batch) {
        const meta = parseMatchMeta(blobs.get(seriesId) ?? null);
        rememberMatchMeta(seriesId, { stamp, ...meta });
        byId.get(seriesId)!.meta = meta;
      }
    }
    // Series without match-derived artists fall back to Kavita's own people
    // (pencillers/inkers/writers), so unmatched entries can also be searched by artist.
    // Read tags for every series, sharing the existing bounded metadata/artist
    // cache. Live Kavita tags take precedence over older provider match data.
    const searchMetadata = await kavitaSeriesSearchMetadata(client, seriesIds);
    const json = JSON.stringify(
      series.map((s) => {
        const match = byId.get(s.id);
        const m = match?.row;
        const liveMeta = searchMetadata.get(s.id);
        const matchArtists = match?.meta.artists ?? [];
        return {
          id: s.id,
          name: s.name,
          dateAdded: s.created ?? null,
          slug: s.slug,
          bookCount: s.bookCount,
          pageCount: s.pages ?? null,
          cover: s.cover ? kavitaCoverUrl(s.id, s.cover, m?.lastSyncedAt) : null,
          status: m?.status ?? 'unmatched',
          providerId: m?.providerId ?? null,
          matchScore: m?.matchScore ?? null,
          confirmed: m?.confirmed ?? false,
          lastSyncedAt: m?.lastSyncedAt ?? null,
          errorMessage: m?.errorMessage ?? null,
          artists: matchArtists.length > 0 ? matchArtists : (liveMeta?.artists ?? []),
          tags: liveMeta?.tags ?? match?.meta.tags ?? [] };
      }),
    );
    const etag = `W/"${Buffer.byteLength(json).toString(36)}-${createHash('sha1').update(json).digest('base64url').slice(0, 22)}"`;
    if (etagMatches(c.req.header('If-None-Match'), etag)) {
      return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'no-cache' } });
    }
    return new Response(json, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=UTF-8', ETag: etag, 'Cache-Control': 'no-cache' },
    });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

api.get('/kavita/series/:id/cover', async (c) => {
  const client = connectedClient();
  if (!client) return c.json({ error: 'Kavita not configured' }, 503);
  try {
    const seriesId = intParam(c.req.param('id'));
    if (seriesId === null) return c.json({ error: 'Invalid series id' }, 400);
    const connKey = kavitaConnectionKey(getKavitaConnection().baseUrl);
    const cacheKey = `${connKey}\0${seriesId}\0${c.req.query('v') ?? ''}`;
    let entry = getSeriesCoverEntry(cacheKey);
    if (!entry) {
      let pending = seriesCoverInflight.get(cacheKey);
      if (!pending) {
        pending = client.getSeriesCover(seriesId).then((cover) => {
          const etag = `W/"${cover.data.length.toString(36)}-${createHash('sha1').update(cover.data).digest('base64url').slice(0, 22)}"`;
          const built: CachedSeriesCover = { seriesId, data: cover.data, contentType: cover.contentType, etag };
          setSeriesCoverEntry(cacheKey, built);
          return built;
        }).finally(() => {
          if (seriesCoverInflight.get(cacheKey) === pending) seriesCoverInflight.delete(cacheKey);
        });
        seriesCoverInflight.set(cacheKey, pending);
      }
      entry = await pending;
    }
    const versioned = Boolean(c.req.query('v'));
    const cacheControl = versioned ? 'private, max-age=86400' : 'private, no-store';
    if (etagMatches(c.req.header('If-None-Match'), entry.etag)) {
      return new Response(null, { status: 304, headers: { 'Cache-Control': cacheControl, ETag: entry.etag } });
    }
    const buffer = entry.data.buffer;
    const bytes = buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer, entry.data.byteOffset, entry.data.byteLength)
      : Uint8Array.from(entry.data);
    return c.body(bytes, 200, {
      'Content-Type': entry.contentType,
      'Cache-Control': cacheControl,
      ETag: entry.etag,
    });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

// ---------------- Series detail / identify / apply ----------------

/** Matched series whose confidence is below the review threshold (local DB only). */
