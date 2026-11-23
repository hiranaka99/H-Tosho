import { rememberDuplicateLibraryRoots } from '../../services/galleryDuplicates.js';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { eq, inArray } from 'drizzle-orm';
import { libraryMutations } from '../../lib/mutations.js';
import { jobQueue } from '../../jobs/queue.js';
import { downloadQueue } from '../../downloader/engine.js';
import { kavitaConnectionKey } from '../../services/kavitaState.js';
import { getDb, schema } from '../../db/index.js';
import { KavitaClient } from '../../kavita/client.js';
import { KAVITA_OPENAPI_VERSION, type KavitaSeries } from '../../kavita/types.js';
import { getKavitaConnection, setKavitaConnection } from '../../services/settings.js';
import { kavitaSeriesSearchMetadata } from '../../services/seriesArtists.js';

import { connectedClient, errMsg, intParam, kavitaCoverUrl } from './helpers.js';
export const api = new Hono();

// A large library's series list is megabytes of repetitive JSON, fetched on open and
// every few seconds while a task runs; gzip shrinks it by roughly 90% on the wire.
api.use('/kavita/libraries/:id/series', compress());

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
    const series = (await client.getSeries(libraryId)) as KavitaSeries[];
    const seriesIds = series.map((s) => s.id);
    const db = getDb();
    const byId = new Map<number, typeof schema.seriesMatches.$inferSelect>();
    for (let i = 0; i < seriesIds.length; i += 400) {
      const batch = seriesIds.slice(i, i + 400);
      for (const row of db.select().from(schema.seriesMatches).where(inArray(schema.seriesMatches.kavitaSeriesId, batch)).all()) {
        byId.set(row.kavitaSeriesId, row);
      }
    }
    // Series without match-derived artists fall back to Kavita's own people
    // (pencillers/inkers/writers), so unmatched entries can also be searched by artist.
    // Read tags for every series, sharing the existing bounded metadata/artist
    // cache. Live Kavita tags take precedence over older provider match data.
    const searchMetadata = await kavitaSeriesSearchMetadata(client, seriesIds);
    return c.json(
      series.map((s) => {
        const m = byId.get(s.id);
        const liveMeta = searchMetadata.get(s.id);
        let parsedMeta: { artists?: unknown; tags?: unknown } | null = null;
        if (m?.metadataJson) {
          try {
            const raw = JSON.parse(m.metadataJson) as unknown;
            if (raw && typeof raw === 'object') parsedMeta = raw as { artists?: unknown; tags?: unknown };
          } catch { /* ignore malformed metadata */ }
        }
        const stringList = (values: unknown): string[] =>
          Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string' && v.trim().length > 0) : [];
        const matchArtists = parsedMeta ? stringList(parsedMeta.artists) : [];
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
          tags: liveMeta?.tags ?? (parsedMeta ? stringList(parsedMeta.tags) : []) };
      }),
    );
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
    const cover = await client.getSeriesCover(seriesId);
    const buffer = cover.data.buffer;
    const bytes = buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer, cover.data.byteOffset, cover.data.byteLength)
      : Uint8Array.from(cover.data);
    const versioned = Boolean(c.req.query('v'));
    return c.body(bytes, 200, {
      'Content-Type': cover.contentType,
      'Cache-Control': versioned ? 'private, max-age=86400' : 'private, no-store' });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

// ---------------- Series detail / identify / apply ----------------

/** Matched series whose confidence is below the review threshold (local DB only). */
