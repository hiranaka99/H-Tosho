import { rememberDuplicateLibraryRoots } from '../../services/galleryDuplicates.js';
import { Hono } from 'hono';
import { getDb, schema } from '../../db/index.js';
import { KavitaClient } from '../../kavita/client.js';
import { KAVITA_OPENAPI_VERSION, type KavitaLibrary, type KavitaSeries } from '../../kavita/types.js';
import { getKavitaConnection, setKavitaConnection } from '../../services/settings.js';
import { kavitaSeriesSearchMetadata } from '../../services/seriesArtists.js';

import { connectedClient, errMsg, intParam, stringsFromMatchMetadata, kavitaCoverUrl } from './helpers.js';
export const api = new Hono();
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

api.post('/kavita/connection', async (c) => {
  const body = (await c.req.json()) as { baseUrl: string; apiKey?: string };
  if (!body.baseUrl) return c.json({ error: 'baseUrl is required' }, 400);
  // A blank key keeps the stored one, so the UI can change the URL without
  // re-entering the secret (the server never returns it).
  const apiKey = body.apiKey?.trim() ? body.apiKey.trim() : getKavitaConnection().apiKey;
  if (!apiKey) return c.json({ error: 'apiKey is required' }, 400);
  setKavitaConnection({ baseUrl: body.baseUrl, apiKey });
  let test: string;
  let connected: boolean;
  try {
    const info = await new KavitaClient(body.baseUrl, apiKey).testConnection();
    test = `Connected (Kavita ${info.version})`;
    connected = true;
  } catch (e) {
    test = 'Saved, but connection test failed: ' + errMsg(e);
    connected = false;
  }
  return c.json({ saved: true, connected, test });
});

api.get('/kavita/libraries', async (c) => {
  const client = connectedClient();
  if (!client) return c.json({ error: 'Kavita not configured' }, 503);
  try {
    const libs = await client.getLibraries();
    rememberDuplicateLibraryRoots(libs);
    const rows = getDb().select().from(schema.seriesMatches).all();
    const matchedIds = new Set(rows.filter((r) => r.status === 'matched').map((r) => r.kavitaSeriesId));
    // Fetch every library's series in parallel (was a sequential per-library
    // round-trip) and count matches with an O(1) set lookup. One failing
    // library must not 502 the whole list: it is reported with zero counts
    // and an error note instead.
    const results = await Promise.allSettled(libs.map((lib) => client.getSeries(lib.id)));
    const out: (KavitaLibrary & { seriesCount: number; matchedCount: number; error?: string })[] = libs.map((l, i) => {
      const r = results[i];
      if (r.status === 'rejected') {
        return { ...l, seriesCount: 0, matchedCount: 0, error: errMsg(r.reason) };
      }
      const series = r.value as KavitaSeries[];
      return {
        ...l,
        seriesCount: series.length,
        matchedCount: series.filter((s) => matchedIds.has(s.id)).length };
    });
    return c.json(out);
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
    const rows = getDb().select().from(schema.seriesMatches).all();
    const byId = new Map(rows.map((r) => [r.kavitaSeriesId, r]));
    // Series without match-derived artists fall back to Kavita's own people
    // (pencillers/inkers/writers), so unmatched entries can also be searched by artist.
    // Read tags for every series, sharing the existing bounded metadata/artist
    // cache. Live Kavita tags take precedence over older provider match data.
    const searchMetadata = await kavitaSeriesSearchMetadata(client, series.map(s => s.id));
    return c.json(
      series.map((s) => {
        const m = byId.get(s.id);
        const matchArtists = stringsFromMatchMetadata(m?.metadataJson);
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
          artists: matchArtists.length > 0 ? matchArtists : (searchMetadata.get(s.id)?.artists ?? []),
          tags: searchMetadata.get(s.id)?.tags ?? stringsFromMatchMetadata(m?.metadataJson, 'tags') };
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
    return c.body(new Uint8Array(cover.data), 200, {
      'Content-Type': cover.contentType,
      'Cache-Control': 'private, no-store' });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

// ---------------- Series detail / identify / apply ----------------

/** Matched series whose confidence is below the review threshold (local DB only). */
