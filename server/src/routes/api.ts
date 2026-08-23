import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { KavitaClient } from '../kavita/client.js';
import { KAVITA_OPENAPI_VERSION, type KavitaLibrary, type KavitaSeries } from '../kavita/types.js';
import { getProvider } from '../providers/registry.js';
import { mangaDexProvider } from '../providers/mangadex.js';
import {
  getAggregationOptions,
  getCredentialMap,
  getGlobalFieldConfig,
  getKavitaConnection,
  getLibraryOverride,
  getNotificationSettings,
  getPollInterval,
  getProviderPriorities,
  parseNotificationSettings,
  getProviderSettings,
  type AggregationOptions,
  setAggregationOptions,
  setGlobalFieldConfig,
  setKavitaConnection,
  setLibraryOverride,
  setNotificationSettings,
  setPollInterval,
  setProviderPriorities,
  setProviderSetting,
  providerOrderFor,
} from '../services/settings.js';
import { jobQueue, type JobType } from '../jobs/queue.js';
import { autoMatch, fetchAggregatedMetadata, type CandidateMatch } from '../match/autoMatcher.js';
import { catalogCandidates, catalogStatus, isMatureAgeRating, resolveCatalogCover } from '../match/mangadexCatalog.js';
import { applyToKavita, fetchCover } from '../services/sync.js';
import { testNotification } from '../notify/dispatcher.js';
import { getDownloaderSettings, setDownloaderSettings, type DownloaderSettings } from '../services/settings.js';
import { downloadQueue } from '../downloader/engine.js';
import { getDoujinProvider, listDoujinProviders } from '../downloader/providers.js';
import { rewriteHitomiCover, rewriteMangaDexCoverUrl } from './media.js';
import { DOUJIN_SORTS, type DoujinSource, type DoujinSort } from '../downloader/types.js';

const CREDENTIAL_FIELDS: Record<string, { key: string; label: string }[]> = {
  myanimelist: [{ key: 'clientId', label: 'Client ID' }],
};

const FIELD_NAMES = [
  'title',
  'sortTitle',
  'summary',
  'genres',
  'tags',
  'writers',
  'artists',
  'publishers',
  'releaseDate',
  'language',
  'status',
  'url',
  'cover',
  'volumeCovers',
] as const;

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
    // round-trip) and count matches with an O(1) set lookup.
    const seriesLists = await Promise.all(libs.map((lib) => client.getSeries(lib.id)));
    const out: (KavitaLibrary & { seriesCount: number; matchedCount: number })[] = libs.map((l, i) => {
      const series = seriesLists[i] as KavitaSeries[];
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
    return c.json(
      series.map((s) => {
        const m = byId.get(s.id);
        return {
          id: s.id,
          name: s.name,
          slug: s.slug,
          bookCount: s.bookCount,
          cover: s.cover ? `/api/kavita/series/${s.id}/cover` : null,
          status: m?.status ?? 'unmatched',
          providerId: m?.providerId ?? null,
          matchScore: m?.matchScore ?? null,
          lastSyncedAt: m?.lastSyncedAt ?? null,
          errorMessage: m?.errorMessage ?? null,
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
    const providerOrder = providerOrderFor(series.libraryId);
    // The local MangaDex adult catalog covers chapterless titles that are
    // invisible to live title search. Flagged-mature series match fuzzily;
    // others only on exact title match (see catalogCandidates).
    let extraCandidates: CandidateMatch[] = [];
    if (providerOrder.includes('mangadex')) {
      const meta = await client.getSeriesMetadata(seriesId).catch(() => null);
      extraCandidates = catalogCandidates(series.name, isMatureAgeRating(meta?.ageRating));
    }
    const outcome = await autoMatch(series, { providerOrder, credentials, enabledProviders, extraCandidates });
    // Scoring improves over time (e.g. title-variant matching), so a stored
    // match can carry a stale confidence. Refresh it when the matched series
    // still surfaces in this run's candidates.
    const existingMatch = getDb().select().from(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, seriesId)).get();
    if (existingMatch) {
      const current = outcome.candidates.find(
        (cand) => cand.providerId === existingMatch.providerId && cand.providerSeriesId === existingMatch.providerSeriesId,
      );
      if (current && current.score !== existingMatch.matchScore) {
        getDb().update(schema.seriesMatches).set({ matchScore: current.score }).where(eq(schema.seriesMatches.kavitaSeriesId, seriesId)).run();
      }
    }
    // MangaDex search thumbnails resolve the main cover_art, but Apply & Sync
    // pushes the Volume 1 cover when one exists — swap the thumbnail so the
    // dialog previews exactly what will land in Kavita. Catalog entries carry
    // no cover until resolved (the list endpoint only ships relationship
    // stubs); fetch the primary cover once and cache it in the catalog. Live
    // candidates whose thumbnail lookup failed get the same fallback.
    await Promise.all(
      outcome.candidates.map(async (cand) => {
        if (cand.providerId !== 'mangadex') return;
        const preferred = await mangaDexProvider.preferredSeriesCoverUrl(cand.providerSeriesId);
        if (preferred) {
          cand.coverUrl = preferred;
        } else if (!cand.coverUrl) {
          const url = await resolveCatalogCover(cand.providerSeriesId);
          if (url) cand.coverUrl = url;
        }
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

api.post('/series/:id/apply', async (c) => {
  const client = connectedClient();
  if (!client) return c.json({ error: 'Kavita not configured' }, 503);
  const body = (await c.req.json()) as { providerId: string; providerSeriesId: string; excludedFields?: string[]; cover?: boolean; score?: number };
  if (!body.providerId || !body.providerSeriesId) return c.json({ error: 'providerId and providerSeriesId required' }, 400);
  try {
    const seriesId = intParam(c.req.param('id'));
    if (seriesId === null) return c.json({ error: 'Invalid series id' }, 400);
    const series = await client.getSeriesById(seriesId);
    const { credentials, enabledProviders } = getCredentialMap();
    const meta = await fetchAggregatedMetadata(
      { providerId: body.providerId, providerSeriesId: body.providerSeriesId },
      { providerOrder: getProviderPriorities(), credentials, enabledProviders },
      getGlobalFieldConfig(),
    );
    const agg = getAggregationOptions();
    // Per-request overrides from the identify dialog: deselected fields are
    // skipped, and unchecking Cover skips the series cover + volume covers.
    const pushCovers = body.cover !== false && agg.replaceCover;
    const cover = pushCovers ? await fetchCover(client, meta.coverUrl) : null;
    const result = await applyToKavita(client, seriesId, meta, {
      agg,
      fieldConfig: getGlobalFieldConfig(),
      cover,
      volumeCovers: body.cover !== false ? meta.volumeCovers : undefined,
      excludedFields: body.excludedFields ?? [],
      title: series.name,
    });
    const db = getDb();
    // The dialog sends the applied candidate's current score; keep the stored
    // value when absent (older clients).
    const existingRow = db.select().from(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, seriesId)).get();
    const sentScore = typeof body.score === 'number' && Number.isFinite(body.score) ? Math.min(1, Math.max(0, body.score)) : undefined;
    const matchScore = sentScore ?? existingRow?.matchScore ?? null;
    db.insert(schema.seriesMatches)
      .values({
        kavitaSeriesId: seriesId,
        status: result.errors.length ? 'failed' : 'matched',
        providerId: body.providerId,
        providerSeriesId: body.providerSeriesId,
        matchScore,
        metadataJson: JSON.stringify(meta),
        errorMessage: result.errors.length ? result.errors.join('; ') : null,
        lastSyncedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: schema.seriesMatches.kavitaSeriesId,
        set: {
          status: result.errors.length ? 'failed' : 'matched',
          providerId: body.providerId,
          providerSeriesId: body.providerSeriesId,
          matchScore,
          metadataJson: JSON.stringify(meta),
          errorMessage: result.errors.length ? result.errors.join('; ') : null,
          lastSyncedAt: new Date().toISOString(),
        },
      })
      .run();
    return c.json(result);
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

/**
 * Manually unmatch a series: drops the local match row so the series reports
 * as unmatched again and scans will consider it for re-matching. Metadata
 * already pushed to Kavita stays in place (Kavita has no revert API) — re-identify
 * and apply a different candidate to overwrite it.
 */
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
      db.delete(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, seriesId)).run();
      db.insert(schema.syncHistory)
        .values({
          kavitaSeriesId: seriesId,
          seriesTitle: series.name,
          action: 'unmatched',
          detailsJson: JSON.stringify({ providerId: row.providerId, matchScore: row.matchScore }),
        })
        .run();
    }
    return c.json({ ok: true, removed: !!row });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

/**
 * Fetch aggregated metadata for a specific provider series — the same
 * fetch/blend path Apply & Sync uses, so the identify dialog can preview
 * exactly what would be pushed to Kavita.
 */
api.get('/providers/:id/series/:seriesId', async (c) => {
  const provider = getProvider(c.req.param('id'));
  if (!provider) return c.json({ error: 'Unknown provider' }, 404);
  try {
    const { credentials, enabledProviders } = getCredentialMap();
    const meta = await fetchAggregatedMetadata(
      { providerId: provider.id, providerSeriesId: c.req.param('seriesId') },
      { providerOrder: getProviderPriorities(), credentials, enabledProviders },
      getGlobalFieldConfig(),
    );
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

/** Status of the local MangaDex adult-title catalog (used by Settings UI). */
api.get('/mangadex/catalog', (c) => {
  return c.json(catalogStatus());
});

api.get('/settings', (c) => {
  return c.json({
    priorities: getProviderPriorities(),
    aggregation: getAggregationOptions(),
    fieldConfig: getGlobalFieldConfig(),
    fields: FIELD_NAMES,
    notifications: getNotificationSettings(),
    pollInterval: getPollInterval(),
  });
});

api.put('/settings/priorities', async (c) => {
  const body = (await c.req.json()) as { priorities: string[] };
  setProviderPriorities(body.priorities);
  return c.json({ ok: true });
});

api.put('/settings/aggregation', async (c) => {
  const body = (await c.req.json()) as { aggregation: AggregationOptions };
  setAggregationOptions(body.aggregation);
  return c.json({ ok: true });
});

api.put('/settings/field-config', async (c) => {
  const body = (await c.req.json()) as { fieldConfig: Record<string, string | null> };
  setGlobalFieldConfig(body.fieldConfig);
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
  const result = await testNotification();
  return c.json(result);
});

api.put('/settings/poll-interval', async (c) => {
  const body = (await c.req.json()) as { minutes: number };
  setPollInterval(Math.max(0, Number(body.minutes) || 0));
  return c.json({ ok: true });
});

// ---------------- Doujinshi downloader ----------------

api.get('/settings/downloader', (c) => c.json(getDownloaderSettings()));

api.put('/settings/downloader', async (c) => {
  const body = (await c.req.json()) as DownloaderSettings;
  setDownloaderSettings({ ...getDownloaderSettings(), ...body });
  return c.json({ ok: true, settings: getDownloaderSettings() });
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
  const body = (await c.req.json()) as { source: string; galleryId: string; title?: string; format?: 'cbz' | 'folder' };
  if (!body.source || !body.galleryId) return c.json({ error: 'source and galleryId are required' }, 400);
  if (!getDoujinProvider(body.source)) return c.json({ error: `Unknown source: ${body.source}` }, 400);
  const id = downloadQueue.enqueue(body.source as DoujinSource, body.galleryId, body.title ?? null, body.format);
  return c.json({ id, status: 'queued' }, 202);
});

api.get('/downloads', (c) => c.json(downloadQueue.list(100)));

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
  return c.json(ov ?? { libraryId: id, priority: getProviderPriorities(), autoMatch: true, fieldConfig: {} });
});

api.put('/libraries/:id/override', async (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid library id' }, 400);
  // Partial merge: fields omitted from the body keep their current value, so a
  // client can flip a single option without snapshotting the rest.
  const body = (await c.req.json()) as Partial<{ priority: string[]; autoMatch: boolean; fieldConfig: Record<string, string | null> }>;
  const cur = getLibraryOverride(id) ?? { libraryId: id, priority: getProviderPriorities(), autoMatch: true, fieldConfig: {} };
  setLibraryOverride({
    libraryId: id,
    priority: body.priority ?? cur.priority,
    autoMatch: body.autoMatch ?? cur.autoMatch,
    fieldConfig: body.fieldConfig ?? cur.fieldConfig,
  });
  return c.json({ ok: true });
});

// ---------------- Jobs ----------------

api.post('/jobs', async (c) => {
  const body = (await c.req.json()) as { type: JobType; libraryId?: number; seriesId?: number; seriesIds?: number[] };
  if (!body.type) return c.json({ error: 'type is required' }, 400);
  const id = jobQueue.enqueue(body.type, { libraryId: body.libraryId, seriesId: body.seriesId, seriesIds: body.seriesIds });
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

api.get('/logs', (c) => c.json(jobQueue.recentLogs(300)));

api.get('/stats', (c) => {
  const rows = getDb().select().from(schema.seriesMatches).all();
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const jobs = jobQueue.list(100);
  return c.json({
    totalSeries: rows.length,
    byStatus,
    activeJobs: jobs.filter((j) => j.status === 'running' || j.status === 'queued').length,
    recentJobs: jobs.slice(0, 8),
  });
});

api.get('/history', (c) => {
  const rows = getDb().select().from(schema.syncHistory).limit(200).all().reverse();
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