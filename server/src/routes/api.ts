import { prepareDuplicateCheck, findDuplicateReports, recordGalleryIdentity, resolveDuplicateGallery, rememberDuplicateLibraryRoots, lookupLibraryMatches } from '../services/galleryDuplicates.js';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  getWatchedSearchIntervalMinutes,
  parseNotificationSettings,
  getProviderSettings,
  setKavitaConnection,
  setLibraryOverride,
  setNotificationSettings,
  setPollIntervalHours,
  setProviderPriorities,
  setWatchedSearchIntervalMinutes,
  setProviderSetting,
  providerOrderFor,
} from '../services/settings.js';
import { isJobType, jobQueue, type JobContext, type JobPayload } from '../jobs/queue.js';
import { autoMatch, fetchProviderMetadata } from '../match/autoMatcher.js';
import { buildSeriesPayload } from '../services/sync.js';
import { kavitaSeriesSearchMetadata } from '../services/seriesArtists.js';
import { testNotification } from '../notify/dispatcher.js';
import { getDownloaderSettings, parseDownloaderSettings, setDownloaderSettings } from '../services/settings.js';
import { downloadQueue } from '../downloader/engine.js';
import { getDoujinProvider, listDoujinProviders } from '../downloader/providers.js';
import { rewriteDoujinCover, rewriteDoujinPages, rewriteMangaDexCoverUrl } from './media.js';
import { addWatchedSearch, listNewGalleries, listWatchedSearches, removeWatchedSearch, listGalleryFeed, setGalleriesReviewed } from '../services/watchedSearches.js';
import { getRecommendations, dismissAndReplace, undoDismiss, refreshRecommendations, setExcludedLibraries, applyRecommendationFeedback } from '../services/recommendations.js';
import { getRecommendationFeedback, type FeedbackAction } from '../services/recommendationFeedback.js';
import { getRecommendationSettings } from '../services/settings.js';
import { DOUJIN_SORTS, type DoujinSource, type DoujinSort } from '../downloader/types.js';
import { imageMime, listCbzFiles, listCbzImages, readComicInfo, readCoverImage, readZipEntryFromDisk, resolveExistingFile, resolveSeriesHostDir } from '../lib/cbz.js';
import { parseComicInfo } from '../downloader/comicinfo.js';
import { galleryFilesystemName, sanitizeFilename } from '../downloader/util.js';
import { mapLimit } from '../lib/http.js';
import { validateMergeDownloads } from '../jobs/mergeDownloads.js';

const CREDENTIAL_FIELDS: Record<string, { key: string; label: string }[]> = {
  myanimelist: [{ key: 'clientId', label: 'Client ID' }],
};

function connectedClient(): KavitaClient | null {
  const conn = getKavitaConnection();
  if (!conn.baseUrl || !conn.apiKey) return null;
  return new KavitaClient(conn.baseUrl, conn.apiKey);
}

/** Capture live target identities before execution; outages must not block enqueue. */
async function resolveJobContext(payload: JobPayload, client = connectedClient()): Promise<JobContext | undefined> {
  const context = jobQueue.contextForPayload(payload);
  if (!context) return context;
  const pendingIds = new Set(context.series.map((target) => target.id));
  payload.contextPendingSeriesIds = [...pendingIds];
  if (!client) return context;
  const libraryIds = new Set<number>();
  let resolvedCount = 0;
  const [libraries] = await Promise.all([
    client.getLibraries().catch(() => []),
    mapLimit(context.series, 3, async (target) => {
      try {
        const series = await client.getSeriesById(target.id);
        target.name = series.name;
        libraryIds.add(series.libraryId);
        resolvedCount++;
        pendingIds.delete(target.id);
      } catch {
        // Keep a locally known name, or the explicit Series #id placeholder.
      }
    }),
  ]);
  if (context.libraryId === undefined && libraryIds.size === 1 && resolvedCount === context.series.length) {
    context.libraryId = [...libraryIds][0];
  }
  const library = libraries.find((entry) => entry.id === context.libraryId);
  if (library) context.libraryName = library.name;
  payload.contextPendingSeriesIds = [...pendingIds];
  return context;
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
 * Extract searchable strings from stored provider metadata, including fallback
 * tags when a series' Kavita metadata cannot be read.
 */
function stringsFromMatchMetadata(metadataJson: string | null | undefined, field: 'artists' | 'tags' = 'artists'): string[] {
  if (!metadataJson) return [];
  try {
    const meta: unknown = JSON.parse(metadataJson);
    if (meta && typeof meta === 'object' && field in meta) {
      const values = (meta as Record<string, unknown>)[field];
      if (Array.isArray(values)) return values.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map(value => value.trim());
    }
  } catch {
    /* corrupt metadata JSON — treat as no values */
  }
  return [];
}

export const api = new Hono();

api.get('/health', (c) => c.json({ ok: true, name: 'h-tosho', time: new Date().toISOString() }));
const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** App version shown in the UI; read once at startup (static per deployment). */
const APP_VERSION: string | null = (() => {
  try {
    // <server>/<src|dist>/routes/ → two levels up is the server package root.
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
})();

api.get('/version', (c) => c.json({ version: APP_VERSION }));

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
        matchedCount: series.filter((s) => matchedIds.has(s.id)).length,
      };
    });
    return c.json(out);
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

/** Stable until a successful sync, then changes so browsers decode the new cover. */
export function kavitaCoverUrl(seriesId: number, coverImage: string, lastSyncedAt?: string | null): string {
  return `/api/kavita/series/${seriesId}/cover?v=${encodeURIComponent(lastSyncedAt ?? coverImage)}`;
}

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
          tags: searchMetadata.get(s.id)?.tags ?? stringsFromMatchMetadata(m?.metadataJson, 'tags'),
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
      'Cache-Control': 'private, no-store',
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
    .where(and(eq(schema.seriesMatches.status, 'matched'), eq(schema.seriesMatches.confirmed, false), lt(schema.seriesMatches.matchScore, LOW_CONFIDENCE_THRESHOLD)))
    .get();
  return c.json({ count: Number(row?.n ?? 0), threshold: LOW_CONFIDENCE_THRESHOLD });
});

/** Review only uncertain matches, using live names and library membership. */
api.get('/series/needs-review', async (c) => {
  const client = connectedClient();
  if (!client) return c.json({ error: 'Kavita not configured' }, 503);
  const matches = getDb().select().from(schema.seriesMatches)
    .where(and(eq(schema.seriesMatches.status, 'matched'), eq(schema.seriesMatches.confirmed, false), lt(schema.seriesMatches.matchScore, LOW_CONFIDENCE_THRESHOLD))).all();
  if (matches.length === 0) return c.json([]);
  const byId = new Map(matches.map((match) => [match.kavitaSeriesId, match]));
  try {
    const libraries = await client.getLibraries();
    // Fetch identities only, avoiding the metadata fan-out of the library view.
    // Fail visibly if any library cannot be read rather than report a partial queue.
    const results = await Promise.all(libraries.map(async (library) => {
      const series = await client.getSeries(library.id);
      return series.filter((s) => byId.has(s.id)).map((s) => {
        const match = byId.get(s.id)!;
        return {
          id: s.id, name: s.name, libraryId: library.id, libraryName: library.name,
          bookCount: s.bookCount, pageCount: s.pages ?? null,
          cover: s.cover ? kavitaCoverUrl(s.id, s.cover, match.lastSyncedAt) : null,
          status: match.status, providerId: match.providerId, matchScore: match.matchScore,
          confirmed: match.confirmed,
          lastSyncedAt: match.lastSyncedAt,
          artists: stringsFromMatchMetadata(match.metadataJson),
          tags: stringsFromMatchMetadata(match.metadataJson, 'tags'),
        };
      });
    }));
    return c.json(results.flat().sort((a, b) => a.matchScore! - b.matchScore! || a.name.localeCompare(b.name)));
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
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
    // Refresh stored confidence when the current match surfaces in this search.
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
 * HTTP 504. Progress shows in the sidebar; results land in the Jobs page.
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
  const targetPayload: JobPayload = { seriesId };
  const context = await resolveJobContext(targetPayload, client);
  // Identity lookup yields; another request may have enqueued while it ran.
  if (jobQueue.active().some((job) => job.type === 'apply-series' && job.payload.seriesId === seriesId)) {
    return c.json({ error: 'A sync is already running for this series' }, 409);
  }
  const id = jobQueue.enqueue('apply-series', {
    seriesId,
    context,
    contextPendingSeriesIds: targetPayload.contextPendingSeriesIds,
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
    watchedSearchIntervalMinutes: getWatchedSearchIntervalMinutes(),
  });
});

api.put('/settings/priorities', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { priorities?: unknown } | null;
  const priorities = body?.priorities;
  if (!Array.isArray(priorities) || priorities.some((id) => typeof id !== 'string' || !getProvider(id)) || new Set(priorities).size !== priorities.length) {
    return c.json({ error: 'priorities must contain unique known providers' }, 400);
  }
  setProviderPriorities(priorities);
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

api.put('/settings/watched-search-interval', async (c) => {
  const body = (await c.req.json()) as { minutes: number };
  setWatchedSearchIntervalMinutes(Math.max(0, Number(body.minutes) || 0));
  return c.json({ ok: true });
});

// ---------------- Doujinshi downloader ----------------

api.get('/settings/downloader', (c) => c.json(getDownloaderSettings()));

api.put('/settings/downloader', async (c) => {
  const body = await c.req.json().catch(() => null);
  // Older clients omit mappings; preserve saved library access in that case.
  const settings = parseDownloaderSettings(body && typeof body === 'object' && !Array.isArray(body)
    ? { ...body, libraryPathMappings: body.libraryPathMappings === undefined ? getDownloaderSettings().libraryPathMappings : body.libraryPathMappings }
    : body);
  if (!settings) {
    return c.json({ error: 'Invalid downloader settings' }, 400);
  }
  setDownloaderSettings(settings);
  return c.json({ ok: true, settings });
});

/** Update library mounts without replacing unrelated downloader settings. */
api.put('/settings/library-path-mappings', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body?.libraryPathMappings)) {
    return c.json({ error: 'Invalid library folder mappings' }, 400);
  }
  const settings = parseDownloaderSettings({ ...getDownloaderSettings(), libraryPathMappings: body.libraryPathMappings });
  if (!settings) return c.json({ error: 'Invalid library folder mappings' }, 400);
  setDownloaderSettings(settings);
  return c.json({ libraryPathMappings: settings.libraryPathMappings });
});

/** List the available doujinshi sources for the UI source selector. */
api.get('/doujin/providers', (c) => c.json(listDoujinProviders()));

/** Search a doujinshi source by keyword/tag/artist/id-or-url. */
api.post('/doujin/search', async (c) => {
  const body = (await c.req.json()) as { source: string; query: string; sort?: DoujinSort; offset?: number; limit?: number };
  if (!body.source || !body.query?.trim()) return c.json({ error: 'source and query are required' }, 400);
  const provider = getDoujinProvider(body.source);
  if (!provider) return c.json({ error: `Unknown source: ${body.source}` }, 400);
  // Each provider supports its own subset of ordering options.
  // Unknown values fall back to the default ordering.
  const sort: DoujinSort = body.sort && DOUJIN_SORTS.includes(body.sort) ? body.sort : 'default';
  const paged = body.offset !== undefined || body.limit !== undefined;
  if (paged && (!Number.isSafeInteger(body.offset ?? 0) || (body.offset ?? 0) < 0
    || !Number.isSafeInteger(body.limit ?? 25) || (body.limit ?? 25) < 1 || (body.limit ?? 25) > 100)) {
    return c.json({ error: 'offset must be nonnegative and limit must be between 1 and 100' }, 400);
  }
  try {
    if (paged && provider.searchPage) {
      const page = await provider.searchPage(body.query, body.offset ?? 0, body.limit ?? 25, sort);
      return c.json({ ...page, items: page.items.map(rewriteDoujinCover) });
    }
    // Request the full result set (both providers cap internally at ~1000).
    const results = await provider.search(body.query, 1000, sort);
    if (paged) return c.json({ items: results.slice(body.offset ?? 0, (body.offset ?? 0) + (body.limit ?? 25)).map(rewriteDoujinCover), total: results.length });
    // Route hitomi covers through the /media proxy so they carry the Referer
    // their CDN requires (browsers can't send it cross-origin).
    return c.json(results.map(rewriteDoujinCover));
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

/** Autocomplete tag/artist suggestions for a doujinshi source search box. */
api.post('/doujin/suggestions', async (c) => {
  const body = (await c.req.json()) as { source: string; query: string; context?: string };
  if (!body.source || !body.query?.trim()) return c.json({ error: 'source and query are required' }, 400);
  const provider = getDoujinProvider(body.source);
  if (!provider) return c.json({ error: `Unknown source: ${body.source}` }, 400);
  if (typeof provider.suggest !== 'function') return c.json([]);
  try {
    return c.json(await provider.suggest(body.query, 10, typeof body.context === 'string' ? body.context : undefined));
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
    // Page URLs stay behind the authenticated, allowlisted media proxy so the
    // browser never needs provider-specific Referer headers or direct CDN access.
    const gallery = await resolveDuplicateGallery(body.source as DoujinSource, body.idOrUrl);
    recordGalleryIdentity(gallery);
    const { pages, pageFallbacks, requestHeaders: _requestHeaders, resolvePageUrl: _resolvePageUrl, ...meta } = gallery;
    return c.json({ ...rewriteDoujinCover(meta), ...rewriteDoujinPages(pages, pageFallbacks), pageCount: pages.length });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

/** Resolve authoritative metadata and compare against ownership, active work, and local CBZ files. */
api.post('/downloads/library-matches', async (c) => {
  const body = await c.req.json() as { items?: unknown[] };
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100) return c.json({ error: 'Provide 1–100 galleries to check.' }, 400);
  const items = [];
  for (const raw of body.items) {
    const item = raw as { source: DoujinSource; galleryId: string; title: string; artists: string[]; language?: string; pageCount?: number } | null;
    if (!item || getDoujinProvider(item.source)?.id !== item.source || typeof item.galleryId !== 'string' || !item.galleryId.trim() || typeof item.title !== 'string' || !Array.isArray(item.artists) || item.artists.some(artist => typeof artist !== 'string') || (item.language !== undefined && typeof item.language !== 'string') || (item.pageCount !== undefined && (typeof item.pageCount !== 'number' || !Number.isFinite(item.pageCount) || item.pageCount < 0))) return c.json({ error: 'Invalid gallery metadata.' }, 400);
    items.push({ source: item.source, galleryId: item.galleryId, title: item.title, artists: item.artists, language: item.language, pageCount: item.pageCount });
  }
  try { return c.json(await lookupLibraryMatches(items)); }
  catch (error) { return c.json({ error: 'Could not check library matches', message: errMsg(error) }, 502); }
});

api.post('/downloads/duplicates', async (c) => {
  const body = await c.req.json() as { items?: { source: DoujinSource; galleryId: string }[]; refreshLibrary?: boolean };
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100 || body.items.some(item => !item || getDoujinProvider(item.source)?.id !== item.source || typeof item.galleryId !== 'string' || !item.galleryId.trim())) return c.json({ error: 'Provide 1–100 supported galleries to check.' }, 400);
  try { return c.json(findDuplicateReports(await prepareDuplicateCheck(body.items, body.refreshLibrary === true))); }
  catch (error) { return c.json({ error: 'Could not check for duplicates', message: errMsg(error) }, 502); }
});

/** Enqueue a gallery download. */
api.post('/downloads', async (c) => {
  const body = (await c.req.json()) as { source: string; galleryId: string; title?: string; format?: 'cbz' | 'folder'; mergeFolder?: string; chapter?: number; priority?: number; allowDuplicate?: boolean };
  if (!body.source || !body.galleryId) return c.json({ error: 'source and galleryId are required' }, 400);
  if (getDoujinProvider(body.source)?.id !== body.source) return c.json({ error: `Unknown source: ${body.source}` }, 400);
  // Merge options: all chapters of one series land in a shared folder so Kavita
  // groups them together. mergeFolder is a plain folder name, never a path.
  const mergeFolder = body.mergeFolder?.trim() || undefined;
  if (mergeFolder && /[\\/]/.test(mergeFolder)) return c.json({ error: 'mergeFolder must be a plain folder name' }, 400);
  const downloaderSettings = getDownloaderSettings();
  const outputFormat = body.format ?? downloaderSettings.format;
  if (outputFormat !== 'cbz' && outputFormat !== 'folder') return c.json({ error: 'format must be cbz or folder' }, 400);
  if (mergeFolder && outputFormat === 'folder') return c.json({ error: 'Merged downloads require CBZ output' }, 400);
  const chapter = typeof body.chapter === 'number' && Number.isFinite(body.chapter) ? body.chapter : undefined;
  // Duplicate guard: a completed task for this gallery already exists. Re-downloading
  // is possible via the queue's Retry action, which re-runs the stored task.
  const done = downloadQueue.findCompleted(body.source as DoujinSource, body.galleryId);
  if (done) return c.json({ error: 'already-downloaded', message: 'A completed task for this gallery already exists — use Retry in the Download Manager to re-download it.', finishedAt: done.finishedAt ?? null }, 409);
  // Also block duplicates that are queued/downloading/paused (retrying one of
  // those goes through the task's own Retry action, not a new enqueue).
  const active = downloadQueue.findActive(body.source as DoujinSource, body.galleryId);
  if (active) return c.json({ error: 'already-queued', message: 'This gallery is already queued or downloading.', status: active.status }, 409);
  const owned = getDb().select().from(schema.ownedGalleries).where(and(eq(schema.ownedGalleries.source, body.source), eq(schema.ownedGalleries.galleryId, body.galleryId))).get();
  if (owned) return c.json({ error: 'already-downloaded', message: 'This gallery is already owned, even if its download history was cleared.' }, 409);
  if (!downloaderSettings.downloadDirectory.trim()) return c.json({ error: 'Set an output folder in Downloader settings before starting a download.' }, 400);
  // Queue priority: higher runs first; ties keep FIFO order. Defaults to 0.
  const priority = typeof body.priority === 'number' && Number.isFinite(body.priority) ? Math.trunc(body.priority) : 0;
  try {
    const identities = await prepareDuplicateCheck([{ source: body.source as DoujinSource, galleryId: body.galleryId }]);
    // Repeat same-source guards after asynchronous provider/filesystem reads.
    if (downloadQueue.findCompleted(body.source as DoujinSource, body.galleryId)) return c.json({ error: 'already-downloaded' }, 409);
    if (downloadQueue.findActive(body.source as DoujinSource, body.galleryId)) return c.json({ error: 'already-queued' }, 409);
    if (getDb().select().from(schema.ownedGalleries).where(and(eq(schema.ownedGalleries.source, body.source), eq(schema.ownedGalleries.galleryId, body.galleryId))).get()) return c.json({ error: 'already-downloaded' }, 409);
    const check = findDuplicateReports(identities);
    if (body.allowDuplicate !== true && check.reports.some(report => report.matches.length)) return c.json({ error: 'possible-duplicate', ...check }, 409);
    const id = downloadQueue.enqueue(body.source as DoujinSource, body.galleryId, identities[0].title, outputFormat, mergeFolder, chapter, priority);
    return c.json({ id, status: 'queued' }, 202);
  } catch (error) { return c.json({ error: 'Could not check for duplicates', message: errMsg(error) }, 502); }
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
      const base = path.resolve(dl.downloadDirectory);
      const candidates = [
        path.join(base, galleryFilesystemName(title, source, galleryId)),
        path.join(base, sanitizeFilename(title, `Gallery-${galleryId}`)),
      ];
      for (const dir of candidates) {
        try {
          files = listCbzFiles(dir);
        } catch {
          /* try the legacy title-only directory */
        }
        if (files.length > 0) break;
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
    const unsubscribeRemovals = downloadQueue.subscribeRemovals((ids) => {
      void sse.write(`data: ${JSON.stringify({ type: 'removed', ids })}\n\n`).catch(() => {});
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
    unsubscribeRemovals();
  }),
);

api.get('/downloads/:id', (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid download id' }, 400);
  const task = downloadQueue.get(id);
  if (!task) return c.json({ error: 'Download not found' }, 404);
  return c.json(task);
});

/**
 * Cover thumbnail for a completed download: the first image of its .cbz (or
 * output folder), read locally so history rows show covers without any
 * provider round-trip. Served same-origin, so the session cookie authenticates it.
 */
api.get('/downloads/:id/cover', async (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid download id' }, 400);
  const task = downloadQueue.get(id);
  if (!task || task.status !== 'completed' || !task.outputPath) return c.json({ error: 'No cover available' }, 404);
  const img = await readCoverImage(task.outputPath);
  if (!img) return c.json({ error: 'No cover available' }, 404);
  return new Response(img.data, {
    headers: { 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=86400' },
  });
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
  const task = downloadQueue.get(id);
  if (!task) return c.json({ error: 'Download not found' }, 404);
  if (downloadQueue.isRunning(id) || task.status === 'queued' || task.status === 'downloading' || task.status === 'paused') {
    return c.json({ error: 'Active downloads must be cancelled before removal' }, 409);
  }
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

api.get('/watched-searches/feed', (c) => {
  const view = c.req.query('view') ?? 'inbox', source = c.req.query('source'), watch = c.req.query('searchId');
  const offset = Number(c.req.query('offset') ?? 0), limit = Number(c.req.query('limit') ?? 25);
  if (!['inbox', 'history'].includes(view) || (source && source !== 'hitomi' && source !== 'nhentai') || (watch !== undefined && (!Number.isSafeInteger(Number(watch)) || Number(watch) < 1)) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return c.json({ error: 'Invalid feed filters or page.' }, 400);
  const feed = listGalleryFeed({ view: view as 'inbox' | 'history', source, searchId: watch ? Number(watch) : undefined, offset, limit });
  return c.json({ ...feed, items: feed.items.map(rewriteDoujinCover) });
});

api.post('/watched-searches/review', async (c) => {
  const body = await c.req.json().catch(() => null) as { items?: { source: DoujinSource; galleryId: string }[]; reviewed?: boolean } | null;
  if (!body || typeof body.reviewed !== 'boolean' || !Array.isArray(body.items) || !body.items.length || body.items.length > 100 || body.items.some(item => !item || !['hitomi', 'nhentai'].includes(item.source) || typeof item.galleryId !== 'string' || !item.galleryId.trim())) return c.json({ error: 'Provide 1–100 galleries and a reviewed state.' }, 400);
  if (!setGalleriesReviewed(body.items, body.reviewed)) return c.json({ error: 'Discovery not found. Refresh the feed and try again.' }, 404);
  return c.json({ ok: true });
});

/** Newest-first feed of galleries the watches reported as new ("Recently added"). */
api.get('/watched-searches/new', (c) => {
  const limitParam = Number(c.req.query('limit') ?? '100');
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 500) : 100;
  // Hitomi covers need the /media proxy (their CDN requires a Referer the browser can't send).
  return c.json(listNewGalleries(limit).map(rewriteDoujinCover));
});

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

api.post('/watched-searches/check', (c) => {
  const active = jobQueue.active().find((job) => job.type === 'check-watched-searches');
  if (active) return c.json({ id: active.id, alreadyRunning: true }, 202);
  const id = jobQueue.enqueue('check-watched-searches', {});
  return c.json({ id, alreadyRunning: false }, 202);
});

api.get('/watched-searches/check-status', (c) => c.json(jobQueue.active().find(job => job.type === 'check-watched-searches') ?? jobQueue.latest('check-watched-searches')));

// ---------------- Recommendations ----------------

/** Today's recommendations — cached per local date; generated on first request of the day. */
api.get('/recommendations', async (c) => {
  try {
    const set = await getRecommendations();
    // Hitomi covers need the /media proxy (their CDN requires a Referer the browser can't send).

    return c.json({ ...set, items: set.items.map(rewriteDoujinCover) });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

/** Re-roll today's picks with a fresh seed (manual refresh from the UI). */
api.post('/recommendations/refresh', async (c) => {
  try {
    const set = await refreshRecommendations();
    return c.json({ ...set, items: set.items.map(rewriteDoujinCover) });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

/** Permanently dismiss a gallery and promote a cached replacement. */
api.post('/recommendations/dismiss', async (c) => {
  const body = await c.req.json<{ source?: unknown; galleryId?: unknown }>().catch(() => null);
  const source = body?.source;
  const galleryId = typeof body?.galleryId === 'string' ? body.galleryId.trim() : '';
  if (source !== 'hitomi' && source !== 'nhentai' || !galleryId) {
    return c.json({ error: 'source (hitomi|nhentai) and galleryId are required' }, 400);
  }
  const set = await dismissAndReplace(source, galleryId);
  return c.json({ ...set, items: set.items.map(rewriteDoujinCover) });
});

api.post('/recommendations/undo-dismiss', async (c) => {
  const body = await c.req.json<{ source?: unknown; galleryId?: unknown }>().catch(() => null);
  const source = body?.source;
  const galleryId = typeof body?.galleryId === 'string' ? body.galleryId.trim() : '';
  if (source !== 'hitomi' && source !== 'nhentai' || !galleryId) return c.json({ error: 'source (hitomi|nhentai) and galleryId are required' }, 400);
  const set = await undoDismiss(source, galleryId);
  return c.json({ ...set, items: set.items.map(rewriteDoujinCover) });
});

/** Which Kavita libraries feed the recommendation profile. */
api.get('/recommendations/settings', (c) => c.json(getRecommendationSettings()));

api.get('/recommendations/feedback', (c) => c.json(getRecommendationFeedback()));
api.post('/recommendations/feedback', async (c) => {
  const body = await c.req.json().catch(() => null);
  const actions: FeedbackAction[] = ['like', 'unlike', 'mute-artist', 'unmute-artist'];
  if (!body || !actions.includes(body.action) || body.source !== 'hitomi'
    || typeof body.galleryId !== 'string' || !body.galleryId.trim() || body.galleryId.length > 200
    || (body.action.includes('artist') && (typeof body.artist !== 'string' || !body.artist.trim() || body.artist.length > 200))) return c.json({ error: 'Invalid recommendation feedback' }, 400);
  try {
    const result = await applyRecommendationFeedback(body.action, { source: body.source, galleryId: body.galleryId.trim(), artist: body.artist });
    return c.json({ ...result, recommendations: { ...result.recommendations, items: result.recommendations.items.map(rewriteDoujinCover) } });
  } catch (error) { return c.json({ error: errMsg(error) }, 400); }
});

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
    rememberDuplicateLibraryRoots(libs);
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

/** List the image entries (pages) of a .cbz in reading order. */
api.get('/cbz/images', async (c) => {
  const file = c.req.query('path');
  const full = file ? resolveExistingFile(file) : null;
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
  const full = file ? resolveExistingFile(file) : null;
  if (!full || !full.toLowerCase().endsWith('.cbz') || !name) {
    return c.json({ error: 'Path and entry name are required' }, 400);
  }
  const mime = imageMime(name);
  if (!mime) return c.json({ error: 'Entry is not a recognized image' }, 400);
  try {
    const buf = await readZipEntryFromDisk(full, name);
    return new Response(buf, { status: 200, headers: { 'Content-Type': mime, 'Cache-Control': 'private, max-age=3600' } });
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
    mappings: dl.libraryPathMappings,
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
  const body = (await c.req.json()) as { type?: unknown; libraryId?: number; seriesId?: number; seriesIds?: number[]; path?: string; xml?: string; fields?: Record<string, string>; sourceFiles?: string[]; targetDir?: string; chapters?: Record<string, string>; existingChapters?: Record<string, string>; downloads?: unknown; providerId?: string; providerSeriesId?: string; selectedTitle?: string; excludedFields?: string[]; cover?: boolean; score?: number };
  if (!isJobType(body.type)) return c.json({ error: 'Unsupported job type' }, 400);
  try { validateMergeDownloads(body.downloads); } catch (error) { return c.json({ error: errMsg(error) }, 400); }
  const payload: JobPayload = { libraryId: body.libraryId, seriesId: body.seriesId, seriesIds: body.seriesIds, path: body.path, xml: body.xml, fields: body.fields, sourceFiles: body.sourceFiles, targetDir: body.targetDir, chapters: body.chapters, existingChapters: body.existingChapters, downloads: body.downloads, providerId: body.providerId, providerSeriesId: body.providerSeriesId, selectedTitle: body.selectedTitle, excludedFields: body.excludedFields, cover: body.cover, score: body.score };
  if (body.type === 'merge-series' && payload.downloads?.length) {
    try {
      const identities = await prepareDuplicateCheck(payload.downloads);
      const check = findDuplicateReports(identities, payload.sourceFiles);
      if (check.reports.some(report => report.matches.length && !payload.downloads!.find(plan => plan.source === report.source && plan.galleryId === report.galleryId)?.allowDuplicate)) return c.json({ error: 'possible-duplicate', ...check }, 409);
    } catch (error) { return c.json({ error: 'Could not check for duplicates', message: errMsg(error) }, 502); }
  }
  payload.context = await resolveJobContext(payload);
  const id = jobQueue.enqueue(body.type, payload);
  return c.json({ id }, 202);
});

api.get('/jobs', (c) => c.json(jobQueue.list(100)));

api.delete('/jobs/failed', (c) => c.json({ removed: jobQueue.clearFailed() }));

api.delete('/jobs/:id', (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null || id <= 0) return c.json({ error: 'Invalid job id' }, 400);
  if (!jobQueue.get(id)) return c.json({ error: 'Job not found' }, 404);
  const removed = jobQueue.clearFailed(id);
  if (!removed) return c.json({ error: 'Only failed jobs can be cleared' }, 409);
  return c.json({ removed });
});

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
