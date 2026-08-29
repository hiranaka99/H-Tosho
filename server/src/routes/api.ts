import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { KavitaClient } from '../kavita/client.js';
import { KAVITA_OPENAPI_VERSION, type KavitaLibrary, type KavitaSeries } from '../kavita/types.js';
import { getProvider } from '../providers/registry.js';
import { mangaDexProvider } from '../providers/mangadex.js';
import type { SeriesMetadata } from '../providers/types.js';
import type { CandidateMatch } from '../match/autoMatcher.js';
import { titleScore } from '../match/normalize.js';
import { parseManualProviderUrl } from '../match/manualMatch.js';
import {
  getCredentialMap,
  getKavitaConnection,
  getLibraryOverride,
  getNotificationSettings,
  getPollIntervalHours,
  getProviderPriorities,
  parseNotificationSettings,
  getProviderSettings,
  setKavitaConnection,
  setLibraryOverride,
  setNotificationSettings,
  setPollIntervalHours,
  setProviderPriorities,
  setProviderSetting,
  providerOrderFor,
} from '../services/settings.js';
import { isJobType, jobQueue } from '../jobs/queue.js';
import { autoMatch, fetchProviderMetadata } from '../match/autoMatcher.js';
import { buildSeriesPayload, checkAlignment } from '../services/sync.js';
import { kavitaSeriesArtists } from '../services/seriesArtists.js';
import { testNotification } from '../notify/dispatcher.js';
import { getDownloaderSettings, parseDownloaderSettings, setDownloaderSettings } from '../services/settings.js';
import { downloadQueue } from '../downloader/engine.js';
import { getDoujinProvider, listDoujinProviders } from '../downloader/providers.js';
import { rewriteHitomiCover, rewriteMangaDexCoverUrl } from './media.js';
import { addWatchedSearch, listWatchedSearches, removeWatchedSearch } from '../services/watchedSearches.js';
import { getRecommendations, markOwned, refreshRecommendations, setExcludedLibraries } from '../services/recommendations.js';
import { getRecommendationSettings } from '../services/settings.js';
import { DOUJIN_SORTS, type DoujinSource, type DoujinSort } from '../downloader/types.js';
import { listCbzFiles, readComicInfo, resolveExistingFile, resolveSeriesHostDir } from '../lib/cbz.js';
import { parseComicInfo } from '../downloader/comicinfo.js';
import { sanitizeFilename } from '../downloader/util.js';

const CREDENTIAL_FIELDS: Record<string, { key: string; label: string }[]> = {
  myanimelist: [{ key: 'clientId', label: 'Client ID' }],
};

function connectedClient(): KavitaClient | null {
  const conn = getKavitaConnection();
  if (!conn.baseUrl || !conn.apiKey) return null;
  return new KavitaClient(conn.baseUrl, conn.apiKey);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
/**
 * Parse an integer route parameter. Returns null for non-integers so callers
 * can answer 400 — a NaN id would otherwise bind as NULL against NOT NULL
 * primary keys and surface as an unhandled 500.
 */
function intParam(raw: string | undefined): number | null {
  if (!raw || !/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Extract provider artist names from a stored match row's metadata JSON.
 * Matched series carry the provider metadata (including `artists`) locally,
 * so library lists can surface artists without extra Kavita round-trips.
 */
function artistsFromMetadata(metadataJson: string | null | undefined): string[] {
  if (!metadataJson) return [];
  try {
    const meta: unknown = JSON.parse(metadataJson);
    if (meta && typeof meta === 'object' && 'artists' in meta && Array.isArray(meta.artists)) {
      return meta.artists.filter((a): a is string => typeof a === 'string' && a.trim().length > 0);
    }
  } catch {
    /* corrupt metadata JSON — treat as no artists */
  }
  return [];
}

export const api = new Hono();

api.get('/health', (c) => c.json({ ok: true, name: 'h-tosho', time: new Date().toISOString() }));

// ---------------- Kavita connection ----------------

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
        matchedCount: series.filter((s) => matchedIds.has(s.id)).length,
      };
    });
    return c.json(out);
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

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
    const needIds = series.filter((s) => artistsFromMetadata(byId.get(s.id)?.metadataJson).length === 0).map((s) => s.id);
    const kavitaArtists = await kavitaSeriesArtists(client, needIds);
    return c.json(
      series.map((s) => {
        const m = byId.get(s.id);
        const matchArtists = artistsFromMetadata(m?.metadataJson);
        return {
          id: s.id,
          name: s.name,
          slug: s.slug,
          bookCount: s.bookCount,
          pageCount: s.pages ?? null,
          cover: s.cover ? `/api/kavita/series/${s.id}/cover` : null,
          status: m?.status ?? 'unmatched',
          providerId: m?.providerId ?? null,
          matchScore: m?.matchScore ?? null,
          aligned: m?.aligned ?? false,
          lastSyncedAt: m?.lastSyncedAt ?? null,
          errorMessage: m?.errorMessage ?? null,
          artists: matchArtists.length > 0 ? matchArtists : (kavitaArtists.get(s.id) ?? []),
        };
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
      'Cache-Control': 'private, max-age=300',
    });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

// ---------------- Series detail / identify / apply ----------------

/** Matched series whose confidence is below the review threshold (local DB only). */
const LOW_CONFIDENCE_THRESHOLD = 0.8;
api.get('/series/low-confidence', (c) => {
  // SQL count instead of loading the table and filtering in JS; a NULL score
  // fails the `<` comparison, matching the old `matchScore !== null` guard.
  const row = getDb()
    .select({ n: sql<number>`count(*)` })
    .from(schema.seriesMatches)
    .where(and(eq(schema.seriesMatches.status, 'matched'), lt(schema.seriesMatches.matchScore, LOW_CONFIDENCE_THRESHOLD)))
    .get();
  return c.json({ count: Number(row?.n ?? 0), threshold: LOW_CONFIDENCE_THRESHOLD });
});

api.get('/series/:id', async (c) => {
  const client = connectedClient();
  if (!client) return c.json({ error: 'Kavita not configured' }, 503);
  try {
    const seriesId = intParam(c.req.param('id'));
    if (seriesId === null) return c.json({ error: 'Invalid series id' }, 400);
    const series = await client.getSeriesById(seriesId);
    const row = getDb().select().from(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, seriesId)).get();
    let metadata = null;
    if (row?.metadataJson) {
      try {
        metadata = JSON.parse(row.metadataJson);
      } catch {
        metadata = null;
      }
    }
    // Live Kavita metadata for the identify diff ("current" column).
    let kavita = null;
    try {
      kavita = await client.getSeriesMetadata(seriesId);
    } catch {
      /* series may not have a metadata row yet */
    }
    return c.json({ series, match: row ?? null, metadata, kavita });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

api.get('/series/:id/identify', async (c) => {
  const client = connectedClient();
  if (!client) return c.json({ error: 'Kavita not configured' }, 503);
  try {
    const seriesId = intParam(c.req.param('id'));
    if (seriesId === null) return c.json({ error: 'Invalid series id' }, 400);
    const series = await client.getSeriesById(seriesId);
    const { credentials, enabledProviders } = getCredentialMap();
    const providerOrder = providerOrderFor(series.libraryId, enabledProviders);
    const outcome = await autoMatch(series, { providerOrder, credentials, enabledProviders, searchAll: true });
    // Scoring improves over time (e.g. title-variant matching), so a stored
    // match can carry a stale confidence — and Kavita data drifts after
    // manual edits. Refresh both when the matched series still surfaces in
    // this run's candidates.
    const existingMatch = getDb().select().from(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, seriesId)).get();
    if (existingMatch) {
      const current = outcome.candidates.find(
        (cand) => cand.providerId === existingMatch.providerId && cand.providerSeriesId === existingMatch.providerSeriesId,
      );
      const updates: { matchScore?: number; aligned?: boolean } = {};
      if (current && current.score !== existingMatch.matchScore) updates.matchScore = current.score;
      if (current && existingMatch.providerId && existingMatch.providerSeriesId) {
        try {
          const providerMeta = await fetchProviderMetadata(existingMatch.providerId, existingMatch.providerSeriesId, credentials);
          const kavitaMeta = await client.getSeriesMetadata(seriesId).catch(() => null);
          updates.aligned = checkAlignment({ name: series.name, metadata: kavitaMeta }, providerMeta).aligned;
        } catch {
          /* provider fetch failed — keep the stored flag */
        }
      }
      if (Object.keys(updates).length) {
        getDb().update(schema.seriesMatches).set(updates).where(eq(schema.seriesMatches.kavitaSeriesId, seriesId)).run();
      }
    }
    // MangaDex search thumbnails resolve the main cover_art, but Apply & Sync
    // pushes the Volume 1 cover when one exists — swap the thumbnail so the
    // dialog previews exactly what will land in Kavita.
    await Promise.all(
      outcome.candidates.map(async (cand) => {
        if (cand.providerId !== 'mangadex') return;
        const preferred = await mangaDexProvider.preferredSeriesCoverUrl(cand.providerSeriesId);
        if (preferred) cand.coverUrl = preferred;
      }),
    );
    // MangaDex's cover CDN serves a placeholder card to third-party browser
    // Referers (anything but mangadex.org / "localhost"), so route candidate
    // covers through the same-origin media proxy.
    return c.json({
      ...outcome,
      candidates: outcome.candidates.map((cand) => ({
        ...cand,
        coverUrl: rewriteMangaDexCoverUrl(cand.coverUrl),
      })),
    });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

api.post('/series/:id/manual-match', async (c) => {
  const client = connectedClient();
  if (!client) return c.json({ error: 'Kavita not configured' }, 503);
  const body = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
  if (typeof body?.url !== 'string') return c.json({ error: 'url is required' }, 400);
  const ref = parseManualProviderUrl(body.url);
  if (!ref) return c.json({ error: 'Enter a MangaDex, MyAnimeList, or AniList series URL' }, 400);

  try {
    const seriesId = intParam(c.req.param('id'));
    if (seriesId === null) return c.json({ error: 'Invalid series id' }, 400);
    const series = await client.getSeriesById(seriesId);
    const { credentials } = getCredentialMap();
    const meta = await fetchProviderMetadata(ref.providerId, ref.providerSeriesId, credentials);
    const candidate: CandidateMatch = {
      providerId: ref.providerId,
      providerSeriesId: ref.providerSeriesId,
      title: meta.title,
      type: ref.type,
      year: meta.year,
      coverUrl: rewriteMangaDexCoverUrl(meta.coverUrl),
      summary: meta.summary,
      score: titleScore(series.name, meta.title),
      fromProvider: {
        providerId: ref.providerId,
        providerSeriesId: ref.providerSeriesId,
        title: meta.title,
        type: ref.type,
        year: meta.year,
        coverUrl: meta.coverUrl,
        summary: meta.summary,
      },
    };
    return c.json(candidate);
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});


/**
 * Queue a user-selected candidate for push to Kavita ("Apply & Sync"). The
 * push includes the ComicInfo.Series rename flow, which waits for Kavita's
 * scan — potentially minutes — so it runs as a background job: holding this
 * request open that long is what intermediate gateways were timing out with
 * HTTP 504. Progress shows in the sidebar; results land in the Jobs page and,
 * when configured, Discord.
 */
api.post('/series/:id/apply', async (c) => {
  const client = connectedClient();
  if (!client) return c.json({ error: 'Kavita not configured' }, 503);
  const body = (await c.req.json()) as { providerId: string; providerSeriesId: string; selectedTitle?: string; excludedFields?: string[]; cover?: boolean; score?: number };
  if (!body.providerId || !body.providerSeriesId) return c.json({ error: 'providerId and providerSeriesId required' }, 400);
  const seriesId = intParam(c.req.param('id'));
  if (seriesId === null) return c.json({ error: 'Invalid series id' }, 400);
  // One apply per series at a time — concurrent runs would race over the same CBZ files.
  const busy = jobQueue.active().some((j) => j.type === 'apply-series' && j.payload.seriesId === seriesId);
  if (busy) return c.json({ error: 'A sync is already running for this series' }, 409);
  const id = jobQueue.enqueue('apply-series', {
    seriesId,
    providerId: body.providerId,
    providerSeriesId: body.providerSeriesId,
    selectedTitle: body.selectedTitle,
    excludedFields: body.excludedFields,
    cover: body.cover,
    score: body.score,
  });
  return c.json({ id });
});

/** Remove the local match and metadata/cover that its latest successful sync applied. */
api.delete('/series/:id/match', async (c) => {
  const client = connectedClient();
  if (!client) return c.json({ error: 'Kavita not configured' }, 503);
  try {
    const seriesId = intParam(c.req.param('id'));
    if (seriesId === null) return c.json({ error: 'Invalid series id' }, 400);
    const series = await client.getSeriesById(seriesId);
    const db = getDb();
    const row = db.select().from(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, seriesId)).get();
    if (row) {
      const history = db
        .select()
        .from(schema.syncHistory)
        .where(eq(schema.syncHistory.kavitaSeriesId, seriesId))
        .orderBy(desc(schema.syncHistory.id))
        .all();
      const details = history.map((entry) => parseHistoryDetails(entry.detailsJson));
      const pushed = [...new Set(details.flatMap((entry) =>
        Array.isArray(entry?.pushed) ? entry.pushed.filter((field): field is string => typeof field === 'string') : [],
      ))];
      const metadata = row.metadataJson ? JSON.parse(row.metadataJson) as SeriesMetadata : null;
      if (metadata && pushed.length > 0) await client.removeSeriesMetadata(seriesId, buildSeriesPayload(metadata), pushed);
      const coverUpdated = details.some((entry) => entry?.coverUpdated === true);
      if (coverUpdated) await client.resetSeriesCover(seriesId);
      const volumeCoversUpdated = details.some((entry) => typeof entry?.volumeCoversUpdated === 'number' && entry.volumeCoversUpdated > 0);
      if (volumeCoversUpdated) {
        for (const volume of await client.getVolumes(seriesId)) await client.resetVolumeCover(volume.id);
      }
      await client.scanSeries(series.libraryId, seriesId);

      db.delete(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, seriesId)).run();
      db.insert(schema.syncHistory)
        .values({
          kavitaSeriesId: seriesId,
          seriesTitle: series.name,
          action: 'unmatched',
          detailsJson: JSON.stringify({ providerId: row.providerId, matchScore: row.matchScore, removedFields: pushed, coverReset: coverUpdated, volumeCoversReset: volumeCoversUpdated }),
        })
        .run();
    }
    return c.json({ ok: true, removed: !!row });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

/** Parse a history row's details JSON into an object (null when absent/corrupt). */
function parseHistoryDetails(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* corrupt details — surface the action only */
  }
  return null;
}

/** Recent sync/match history for one series (newest first, capped at 100). */
api.get('/series/:id/history', (c) => {
  const seriesId = intParam(c.req.param('id'));
  if (seriesId === null) return c.json({ error: 'Invalid series id' }, 400);
  const rows = getDb()
    .select()
    .from(schema.syncHistory)
    .where(eq(schema.syncHistory.kavitaSeriesId, seriesId))
    .orderBy(desc(schema.syncHistory.id))
    .limit(100)
    .all();
  return c.json(rows.map((r) => ({ id: r.id, action: r.action, details: parseHistoryDetails(r.detailsJson), createdAt: r.createdAt })));
});

/**
 * Fetch full metadata for a specific provider series — the same path Apply &
 * Sync uses, so the identify dialog can preview exactly what would be pushed
 * to Kavita.
 */
api.get('/providers/:id/series/:seriesId', async (c) => {
  const provider = getProvider(c.req.param('id'));
  if (!provider) return c.json({ error: 'Unknown provider' }, 404);
  try {
    const { credentials } = getCredentialMap();
    const meta = await fetchProviderMetadata(provider.id, c.req.param('seriesId'), credentials);
    return c.json({
      ...meta,
      coverUrl: rewriteMangaDexCoverUrl(meta.coverUrl),
      volumeCovers: meta.volumeCovers?.map((v) => ({ ...v, url: rewriteMangaDexCoverUrl(v.url) ?? v.url })),
    });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

// ---------------- Providers & settings ----------------

api.get('/providers', (c) => {
  const settings = getProviderSettings();
  const out = Object.entries(settings).map(([id, s]) => {
    const p = getProvider(id);
    return {
      id,
      name: p?.name ?? id,
      color: p?.color ?? '#888888',
      helpUrl: p?.helpUrl ?? null,
      supportedTypes: p?.supportedTypes ?? [],
      requiresCredentials: p?.requiresCredentials ?? false,
      providesFields: p?.providesFields ?? [],
      credentialFields: CREDENTIAL_FIELDS[id] ?? [],
      enabled: s.enabled,
      hasCredentials: Object.values(s.credentials).some((v) => v && v.length > 0),
      credentials: s.credentials,
    };
  });
  return c.json(out);
});

api.put('/providers/:id', async (c) => {
  const id = c.req.param('id');
  if (!getProvider(id)) return c.json({ error: 'Unknown provider' }, 404);
  const body = (await c.req.json()) as { enabled?: boolean; credentials?: Record<string, string> };
  setProviderSetting(id, { enabled: body.enabled, credentials: body.credentials });
  return c.json({ ok: true });
});

api.post('/providers/:id/test', async (c) => {
  const id = c.req.param('id');
  const p = getProvider(id);
  if (!p) return c.json({ error: 'Unknown provider' }, 404);
  const s = getProviderSettings()[id];
  try {
    p.setCredentials(s.credentials);
    await p.testConnection();
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, error: errMsg(e) });
  }
});

api.get('/settings', (c) => {
  return c.json({
    priorities: getProviderPriorities(),
    notifications: getNotificationSettings(),
    pollIntervalHours: getPollIntervalHours(),
  });
});

api.put('/settings/priorities', async (c) => {
  const body = (await c.req.json()) as { priorities: string[] };
  setProviderPriorities(body.priorities);
  return c.json({ ok: true });
});

api.put('/settings/notifications', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { notifications?: unknown } | null;
  const parsed = parseNotificationSettings(body?.notifications);
  if (!parsed) {
    return c.json({ error: 'Invalid notification settings: expected { discord: { enabled, webhookUrl } }' }, 400);
  }
  setNotificationSettings(parsed);
  return c.json({ ok: true });
});

api.put('/settings/notifications/test', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { notifications?: unknown } | null;
  const settings = parseNotificationSettings(body?.notifications);
  if (!settings) return c.json({ error: 'Invalid notification settings' }, 400);
  return c.json(await testNotification(settings));
});

api.put('/settings/poll-interval', async (c) => {
  const body = (await c.req.json()) as { hours: number };
  setPollIntervalHours(Math.max(0, Number(body.hours) || 0));
  return c.json({ ok: true });
});

// ---------------- Doujinshi downloader ----------------

api.get('/settings/downloader', (c) => c.json(getDownloaderSettings()));

api.put('/settings/downloader', async (c) => {
  const body = await c.req.json().catch(() => null);
  const settings = parseDownloaderSettings(body);
  if (!settings) {
    return c.json({ error: 'Invalid downloader settings' }, 400);
  }
  setDownloaderSettings(settings);
  return c.json({ ok: true, settings });
});

/** List the available doujinshi sources for the UI source selector. */
api.get('/doujin/providers', (c) => c.json(listDoujinProviders()));

/** Search a doujinshi source by keyword/tag/artist/id-or-url. */
api.post('/doujin/search', async (c) => {
  const body = (await c.req.json()) as { source: string; query: string; sort?: DoujinSort };
  if (!body.source || !body.query?.trim()) return c.json({ error: 'source and query are required' }, 400);
  const provider = getDoujinProvider(body.source);
  if (!provider) return c.json({ error: `Unknown source: ${body.source}` }, 400);
  // Optional popularity ordering (nHentai only; other providers ignore it).
  // Unknown values fall back to the default ordering.
  const sort: DoujinSort = body.sort && DOUJIN_SORTS.includes(body.sort) ? body.sort : 'default';
  try {
    // Request the full result set (both providers cap internally at ~1000).
    const results = await provider.search(body.query, 1000, sort);
    // Route hitomi covers through the /media proxy so they carry the Referer
    // their CDN requires (browsers can't send it cross-origin).
    return c.json(results.map(rewriteHitomiCover));
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

/** Autocomplete tag/artist suggestions for a doujinshi source search box. */
api.post('/doujin/suggestions', async (c) => {
  const body = (await c.req.json()) as { source: string; query: string };
  if (!body.source || !body.query?.trim()) return c.json({ error: 'source and query are required' }, 400);
  const provider = getDoujinProvider(body.source);
  if (!provider) return c.json({ error: `Unknown source: ${body.source}` }, 400);
  if (typeof provider.suggest !== 'function') return c.json([]);
  try {
    return c.json(await provider.suggest(body.query, 10));
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

/** Resolve full gallery metadata + image list (for preview / page count). */
api.post('/doujin/gallery', async (c) => {
  const body = (await c.req.json()) as { source: string; idOrUrl: string };
  if (!body.source || !body.idOrUrl?.trim()) return c.json({ error: 'source and idOrUrl are required' }, 400);
  const provider = getDoujinProvider(body.source);
  if (!provider) return c.json({ error: `Unknown source: ${body.source}` }, 400);
  try {
    // Return metadata without exposing the full image URL list (keeps payload small).
    const gallery = await provider.getGallery(body.idOrUrl);
    const { pages, ...meta } = gallery;
    return c.json({ ...rewriteHitomiCover(meta), pageCount: pages.length });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

/** Enqueue a gallery download. */
api.post('/downloads', async (c) => {
  const body = (await c.req.json()) as { source: string; galleryId: string; title?: string; format?: 'cbz' | 'folder'; mergeFolder?: string; chapter?: number; priority?: number };
  if (!body.source || !body.galleryId) return c.json({ error: 'source and galleryId are required' }, 400);
  if (!getDoujinProvider(body.source)) return c.json({ error: `Unknown source: ${body.source}` }, 400);
  // Merge options: all chapters of one series land in a shared folder so Kavita
  // groups them together. mergeFolder is a plain folder name, never a path.
  const mergeFolder = body.mergeFolder?.trim() || undefined;
  if (mergeFolder && /[\\/]/.test(mergeFolder)) return c.json({ error: 'mergeFolder must be a plain folder name' }, 400);
  const chapter = typeof body.chapter === 'number' && Number.isFinite(body.chapter) ? body.chapter : undefined;
  // Duplicate guard: a completed task for this gallery already exists. Re-downloading
  // is possible via the queue's Retry action, which re-runs the stored task.
  const done = downloadQueue.findCompleted(body.source as DoujinSource, body.galleryId);
  if (done) return c.json({ error: 'already-downloaded', message: 'A completed task for this gallery already exists — use Retry in the Download Manager to re-download it.', finishedAt: done.finishedAt ?? null }, 409);
  // Also block duplicates that are queued/downloading/paused (retrying one of
  // those goes through the task's own Retry action, not a new enqueue).
  const active = downloadQueue.findActive(body.source as DoujinSource, body.galleryId);
  if (active) return c.json({ error: 'already-queued', message: 'This gallery is already queued or downloading.', status: active.status }, 409);
  // Queue priority: higher runs first; ties keep FIFO order. Defaults to 0.
  const priority = typeof body.priority === 'number' && Number.isFinite(body.priority) ? Math.trunc(body.priority) : 0;
  const id = downloadQueue.enqueue(body.source as DoujinSource, body.galleryId, body.title ?? null, body.format, mergeFolder, chapter, priority);
  return c.json({ id, status: 'queued' }, 202);
});

api.get('/downloads', (c) => c.json(downloadQueue.list(100)));

/** Completed galleries (source + galleryId + finish time) for duplicate badges. */
api.get('/downloads/completed', (c) => c.json(downloadQueue.completedGalleries()));

/**
 * Resolve the .cbz file(s) on disk for a gallery. Completed task rows win; when
 * the history was cleared (or the download predates the queue), fall back to the
 * per-gallery folder that writeOutput derives from the sanitized title.
 */
api.get('/downloads/gallery-files', (c) => {
  const source = c.req.query('source');
  const galleryId = c.req.query('galleryId');
  const title = c.req.query('title') ?? '';
  if (!source || !galleryId) return c.json({ error: 'source and galleryId are required' }, 400);
  let files: string[] = [];
  const done = downloadQueue.findCompleted(source as DoujinSource, galleryId);
  if (done?.outputPath?.toLowerCase().endsWith('.cbz') && fs.existsSync(done.outputPath)) {
    files = [done.outputPath];
  } else if (title.trim()) {
    const dl = getDownloaderSettings();
    if (dl.downloadDirectory) {
      const dir = path.join(path.resolve(dl.downloadDirectory), sanitizeFilename(title, `Gallery-${galleryId}`));
      try {
        files = listCbzFiles(dir);
      } catch {
        /* no such folder */
      }
    }
  }
  return c.json({ files });
});

/**
 * Server-Sent Events stream of live download-task updates. The client receives
 * an initial `snapshot` of every task, then a `task` event each time a tracked
 * field changes (throttled server-side). Used for real-time progress without
 * polling; the REST endpoints remain as the fallback/authoritative source.
 */
api.get('/downloads/events', (c) =>
  streamSSE(c, async (sse) => {
    // Push the current state immediately so a freshly-opened client is up to date.
    await sse.write(`data: ${JSON.stringify({ type: 'snapshot', tasks: downloadQueue.list(100) })}\n\n`);

    const unsubscribe = downloadQueue.subscribe((task) => {
      void sse.write(`data: ${JSON.stringify({ type: 'task', task })}\n\n`).catch(() => {});
    });

    // Keep the connection alive so proxies/clients don't time out during idle.
    const heartbeat = setInterval(() => {
      void sse.write(': ping\n\n').catch(() => {});
    }, 15_000);

    await new Promise<void>((resolve) => {
      c.req.raw.signal.addEventListener('abort', () => resolve(), { once: true });
    });

    clearInterval(heartbeat);
    unsubscribe();
  }),
);

api.get('/downloads/:id', (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid download id' }, 400);
  const task = downloadQueue.get(id);
  if (!task) return c.json({ error: 'Download not found' }, 404);
  return c.json(task);
});

const DOWNLOAD_ACTIONS = ['pause', 'resume', 'cancel', 'retry'] as const;
for (const action of DOWNLOAD_ACTIONS) {
  api.post(`/downloads/:id/${action}`, (c) => {
    const id = intParam(c.req.param('id'));
    if (id === null) return c.json({ error: 'Invalid download id' }, 400);
    const ok = downloadQueue[action](id);
    if (!ok) return c.json({ error: `Could not ${action} download` }, 400);
    return c.json({ ok: true });
  });
}

api.delete('/downloads/:id', (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid download id' }, 400);
  downloadQueue.remove(id);
  return c.json({ ok: true });
});

api.post('/downloads/clear-completed', (c) => {
  const removed = downloadQueue.clearCompleted();
  return c.json({ ok: true, removed });
});

// ---------------- Library overrides ----------------

api.get('/libraries/:id/override', (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid library id' }, 400);
  const ov = getLibraryOverride(id);
  return c.json(ov ?? { libraryId: id, priority: getProviderPriorities(), autoMatch: true });
});

api.put('/libraries/:id/override', async (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid library id' }, 400);
  // Partial merge: fields omitted from the body keep their current value, so a
  // client can flip a single option without snapshotting the rest.
  const body = (await c.req.json()) as Partial<{ priority: string[]; autoMatch: boolean }>;
  const cur = getLibraryOverride(id) ?? { libraryId: id, priority: getProviderPriorities(), autoMatch: true };
  setLibraryOverride({
    libraryId: id,
    priority: body.priority ?? cur.priority,
    autoMatch: body.autoMatch ?? cur.autoMatch,
  });
  return c.json({ ok: true });
});

// ---------------- Watched searches ----------------

api.get('/watched-searches', (c) => c.json(listWatchedSearches()));

api.post('/watched-searches', async (c) => {
  const body = (await c.req.json()) as { source?: string; query?: string };
  if (!body.source || !getDoujinProvider(body.source)) return c.json({ error: `Unknown source: ${body.source ?? ''}` }, 400);
  const query = body.query?.trim();
  if (!query) return c.json({ error: 'query is required' }, 400);
  const added = addWatchedSearch(body.source as DoujinSource, query);
  return c.json(added, 201);
});

api.delete('/watched-searches/:id', (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid watched search id' }, 400);
  const removed = removeWatchedSearch(id);
  if (!removed) return c.json({ error: 'Watched search not found' }, 404);
  return c.json({ ok: true });
});

/** Run all watches now (manual trigger; the poll timer also runs this). */
api.post('/watched-searches/check', (c) => {
  const id = jobQueue.enqueue('check-watched-searches', {});
  return c.json({ id }, 202);
});

// ---------------- Recommendations ----------------

/** Today's recommendations — cached per local date; generated on first request of the day. */
api.get('/recommendations', async (c) => {
  try {
    const set = await getRecommendations();
    // Hitomi covers need the /media proxy (their CDN requires a Referer the browser can't send).

    return c.json({ ...set, items: set.items.map(rewriteHitomiCover) });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

/** Re-roll today's picks with a fresh seed (manual refresh from the UI). */
api.post('/recommendations/refresh', async (c) => {
  try {
    const set = await refreshRecommendations();
    return c.json({ ...set, items: set.items.map(rewriteHitomiCover) });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

/** Mark a gallery as owned — it will never be recommended again. */
api.post('/recommendations/owned', async (c) => {
  const body = await c.req.json<{ source?: unknown; galleryId?: unknown }>().catch(() => null);
  const source = body?.source;
  const galleryId = typeof body?.galleryId === 'string' ? body.galleryId.trim() : '';
  if (source !== 'hitomi' && source !== 'nhentai' || !galleryId) {
    return c.json({ error: 'source (hitomi|nhentai) and galleryId are required' }, 400);
  }
  markOwned(source, galleryId);
  return c.json({ ok: true });
});

/** Which Kavita libraries feed the recommendation profile. */
api.get('/recommendations/settings', (c) => c.json(getRecommendationSettings()));

/** Replace the excluded-library list — today's cached set is re-generated. */
api.post('/recommendations/settings', async (c) => {
  const body = await c.req.json<{ excludedLibraryIds?: unknown }>().catch(() => null);
  if (!body || !Array.isArray(body.excludedLibraryIds) || body.excludedLibraryIds.some((x) => typeof x !== 'number')) {
    return c.json({ error: 'excludedLibraryIds must be an array of numbers' }, 400);
  }
  setExcludedLibraries(body.excludedLibraryIds as number[]);
  return c.json(getRecommendationSettings());
});

/** Light Kavita library list (id + name) for the recommendation settings row. */
api.get('/recommendations/libraries', async (c) => {
  const client = connectedClient();
  if (!client) return c.json({ error: 'Kavita not configured' }, 503);
  try {
    const libs = await client.getLibraries();
    return c.json(libs.map((l) => ({ id: l.id, name: l.name })));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});


// ---------------- ComicInfo editor ----------------

/** Browse roots for the file picker: the configured download directory plus Kavita library paths. */
api.get('/cbz/roots', async (c) => {
  const roots: string[] = [];
  const dl = getDownloaderSettings();
  if (dl.downloadDirectory) roots.push(path.resolve(dl.downloadDirectory));
  const client = connectedClient();
  if (client) {
    try {
      for (const lib of await client.getLibraries()) {
        if (lib.path) roots.push(lib.path);
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
  const full = file ? resolveExistingFile(file) : null;
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
  });
  if (!dir || !fs.existsSync(dir)) {
    return c.json({ seriesId: id, name: s.name, dir: null, reason: 'Could not locate this series on this machine — type a path manually.', files: [] });
  }
  const files = listCbzFiles(dir);
  // Prefill chapter numbers (merge dialog) from the archives' existing metadata.
  const chapterNumbers: Record<string, string> = {};
  await Promise.all(
    files.map(async (f) => {
      try {
        const xml = await readComicInfo(f);
        if (xml) {
          const n = parseComicInfo(xml).fields.Number;
          if (n && n.trim()) chapterNumbers[f] = n.trim();
        }
      } catch {
        // unreadable archive — leave the prefill empty
      }
    }),
  );
  return c.json({ seriesId: id, name: s.name, dir, reason: null, files, chapterNumbers });
});
// ---------------- Jobs ----------------

api.post('/jobs', async (c) => {
  const body = (await c.req.json()) as { type?: unknown; libraryId?: number; seriesId?: number; seriesIds?: number[]; path?: string; xml?: string; fields?: Record<string, string>; sourceFiles?: string[]; targetDir?: string; chapters?: Record<string, string>; providerId?: string; providerSeriesId?: string; selectedTitle?: string; excludedFields?: string[]; cover?: boolean; score?: number };
  if (!isJobType(body.type)) return c.json({ error: 'Unsupported job type' }, 400);
  const id = jobQueue.enqueue(body.type, { libraryId: body.libraryId, seriesId: body.seriesId, seriesIds: body.seriesIds, path: body.path, xml: body.xml, fields: body.fields, sourceFiles: body.sourceFiles, targetDir: body.targetDir, chapters: body.chapters, providerId: body.providerId, providerSeriesId: body.providerSeriesId, selectedTitle: body.selectedTitle, excludedFields: body.excludedFields, cover: body.cover, score: body.score });
  return c.json({ id }, 202);
});

api.get('/jobs', (c) => c.json(jobQueue.list(100)));

api.get('/jobs/:id', (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid job id' }, 400);
  const job = jobQueue.get(id);
  if (!job) return c.json({ error: 'Job not found' }, 404);
  return c.json({ job, logs: jobQueue.logs(job.id) });
});

api.post('/jobs/:id/cancel', (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid job id' }, 400);
  if (!jobQueue.cancel(id)) return c.json({ error: 'Job is not active' }, 409);
  return c.json({ ok: true });
});

api.post('/jobs/:id/retry', (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid job id' }, 400);
  const newId = jobQueue.retryJob(id);
  if (newId === null) return c.json({ error: 'Job is not retryable' }, 409);
  return c.json({ ok: true, id: newId });
});

api.get('/logs', (c) => c.json(jobQueue.recentLogs(300)));

api.get('/history', (c) => {
  const rows = getDb().select().from(schema.syncHistory).orderBy(desc(schema.syncHistory.id)).limit(200).all();
  return c.json(
    rows.map((r) => ({
      id: r.id,
      kavitaSeriesId: r.kavitaSeriesId,
      seriesTitle: r.seriesTitle,
      action: r.action,
      details: r.detailsJson,
      createdAt: r.createdAt,
    })),
  );
});