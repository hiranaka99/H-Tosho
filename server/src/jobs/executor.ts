import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { KavitaClient } from '../kavita/client.js';
import {
  getCredentialMap,
  getKavitaConnection,
  getLibraryOverride,
  getProviderPriorities,
  providerOrderFor,
} from '../services/settings.js';
import { autoMatch, fetchProviderMetadata, type CandidateMatch } from '../match/autoMatcher.js';
import { catalogCandidates, catalogNeedsRefresh, isMatureAgeRating, refreshCatalog } from '../match/mangadexCatalog.js';
import { applyToKavita, checkAlignment, fetchCover } from '../services/sync.js';
import { notify } from '../notify/dispatcher.js';
import { jobQueue, JobCancelled, type Job, type LogFn } from './queue.js';

interface Target {
  id: number;
  name: string;
  libraryId?: number;
  /** Series is flagged mature in Kavita (eligible for fuzzy adult-catalog matching). */
  mature?: boolean;
}

interface MatchResult {
  seriesId: number;
  title: string;
  matched: boolean;
  errors: string[];
  coverUrl?: string;
}


function upsertMatch(r: {
  kavitaSeriesId: number;
  status: string;
  providerId: string | null;
  providerSeriesId: string | null;
  matchScore: number | null;
  metadataJson: string | null;
  errorMessage: string | null;
  aligned?: boolean;
}): void {
  getDb()
    .insert(schema.seriesMatches)
    .values({
      kavitaSeriesId: r.kavitaSeriesId,
      status: r.status,
      providerId: r.providerId,
      providerSeriesId: r.providerSeriesId,
      matchScore: r.matchScore,
      metadataJson: r.metadataJson,
      errorMessage: r.errorMessage,
      aligned: r.aligned ?? false,
      lastSyncedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: schema.seriesMatches.kavitaSeriesId,
      set: {
        status: r.status,
        providerId: r.providerId,
        providerSeriesId: r.providerSeriesId,
        matchScore: r.matchScore,
        metadataJson: r.metadataJson,
        errorMessage: r.errorMessage,
        aligned: r.aligned ?? false,
        lastSyncedAt: new Date().toISOString(),
      },
    })
    .run();
}

function recordHistory(seriesId: number, title: string | null, action: string, details: unknown): void {
  getDb()
    .insert(schema.syncHistory)
    .values({ kavitaSeriesId: seriesId, seriesTitle: title, action, detailsJson: JSON.stringify(details) })
    .run();
}

async function matchAndApply(
  client: KavitaClient,
  series: { id: number; name: string; mature?: boolean },
  libraryId: number | undefined,
  force: boolean,
  log?: LogFn,
): Promise<MatchResult> {
  const base: MatchResult = { seriesId: series.id, title: series.name, matched: false, errors: [] };
  const { credentials, enabledProviders } = getCredentialMap();
  const order = providerOrderFor(libraryId);

  if (order.length === 0) {
    base.errors.push('No providers enabled/configured');
    upsertMatch({
      kavitaSeriesId: series.id,
      status: 'unmatched',
      providerId: null,
      providerSeriesId: null,
      matchScore: null,
      metadataJson: null,
      errorMessage: base.errors.join('; '),
    });
    return base;
  }

  // The local MangaDex adult catalog covers chapterless titles that are
  // invisible to live title search. Unflagged series only get exact-title
  // catalog candidates (see catalogCandidates).
  const extraCandidates = order.includes('mangadex') ? catalogCandidates(series.name, !!series.mature) : [];
  const outcome = await autoMatch(series, { providerOrder: order, credentials, enabledProviders, extraCandidates });
  log?.('info', `${series.name}: ${outcome.candidates.length} candidate(s) across [${outcome.searchedProviders.join(', ')}]${extraCandidates.length ? ` +${extraCandidates.length} catalog` : ''}`);

  const best: CandidateMatch | null = outcome.best;
  if (!outcome.matched || !best) {
    base.errors.push('No confident match found');
    upsertMatch({
      kavitaSeriesId: series.id,
      status: 'unmatched',
      providerId: null,
      providerSeriesId: null,
      matchScore: best ? best.score : null,
      metadataJson: null,
      errorMessage: null,
    });
    return base;
  }

  base.matched = true;
  try {
    const meta = await fetchProviderMetadata(best.providerId, best.providerSeriesId, credentials);
    const cover = await fetchCover(client, meta.coverUrl);
    const result = await applyToKavita(client, series.id, meta, {
      cover,
      volumeCovers: meta.volumeCovers,
      title: series.name,
    });
    // Verify the push against Kavita's live state and record whether every
    // provider-managed field now matches (the "Aligned" flag).
    let aligned = false;
    try {
      const full = await client.getSeriesById(series.id);
      const kavitaMeta = await client.getSeriesMetadata(series.id);
      aligned = checkAlignment({ name: full.name, sortName: full.sortName, metadata: kavitaMeta }, meta).aligned;
    } catch {
      /* series without a metadata row yet — stays unaligned */
    }

    const status = result.errors.length ? 'failed' : 'matched';
    upsertMatch({
      kavitaSeriesId: series.id,
      status,
      providerId: best.providerId,
      providerSeriesId: best.providerSeriesId,
      matchScore: best.score,
      metadataJson: JSON.stringify(meta),
      errorMessage: result.errors.length ? result.errors.join('; ') : null,
      aligned,
    });
    recordHistory(series.id, series.name, result.errors.length ? 'failed' : force ? 'updated' : 'matched', {
      providerId: best.providerId,
      score: best.score,
      pushed: result.pushed,
      coverUpdated: result.coverUpdated,
      errors: result.errors,
    });
    base.errors = result.errors;
    base.coverUrl = meta.coverUrl ?? best.coverUrl;

    // Notification failures must not flip an already-applied match to failed —
    // the metadata push succeeded by the time we get here.
    try {
      await notify({
        title: `${force ? 'Updated' : 'Matched'}: ${series.name}`,
        body: `Matched to ${best.providerId} (${Math.round(best.score * 100)}%). Pushed: ${
          result.pushed.length ? result.pushed.join(', ') : 'none'
        }${result.errors.length ? ' — errors: ' + result.errors.join('; ') : ''}`,
        coverUrl: meta.coverUrl ?? best.coverUrl,
        success: result.errors.length === 0,
      });
    } catch (e) {
      log?.('warn', `Notification failed for ${series.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    log?.(result.errors.length ? 'warn' : 'success', `${series.name} -> ${best.providerId} (${Math.round(best.score * 100)}%)`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    base.errors.push(msg);
    upsertMatch({
      kavitaSeriesId: series.id,
      status: 'failed',
      providerId: best.providerId,
      providerSeriesId: best.providerSeriesId,
      matchScore: best.score,
      metadataJson: null,
      errorMessage: msg,
    });
    log?.('error', `${series.name}: ${msg}`);
  }
  return base;
}

function connectedClientOrNull(): KavitaClient | null {
  const conn = getKavitaConnection();
  if (!conn.baseUrl || !conn.apiKey) return null;
  return new KavitaClient(conn.baseUrl, conn.apiKey);
}

/** Run a queued job. Returns a small summary stored on the job row. */
export async function runJob(job: Job, log: LogFn): Promise<Record<string, number>> {
  // The MangaDex catalog refresh talks to MangaDex only — no Kavita needed.
  if (job.type === 'mangadex-catalog') {
    const r = await refreshCatalog({
      log,
      onProgress: (current, total) => jobQueue.setProgress(job.id, current, total),
      isCancelled: () => jobQueue.isCancelRequested(job.id),
    });
    return { processed: 0, matched: 0, failed: 0, added: r.added, updated: r.updated, indexed: r.total };
  }

  const client = connectedClientOrNull();
  if (!client) throw new Error('Kavita is not configured');

  const summary: Record<string, number> = { processed: 0, matched: 0, failed: 0 };
  const targets: Target[] = [];

  const byId = async (id: number): Promise<Target> => {
    const s = (await client.getSeriesById(id)) as { id: number; name: string; libraryId: number };
    return { id: s.id, name: s.name, libraryId: s.libraryId };
  };

  switch (job.type) {
    case 'scan-new': {
      const libs = await client.getLibraries();
      summary.libraries = libs.length;
      const known = new Set(getDb().select().from(schema.seriesMatches).all().map((r) => r.kavitaSeriesId));
      for (const lib of libs) {
        // Libraries with auto-matching disabled are skipped by the scan; their
        // series can still be matched manually via match-library / match-series.
        if (getLibraryOverride(lib.id)?.autoMatch === false) continue;
        if (jobQueue.isCancelRequested(job.id)) throw new JobCancelled();
        const series = (await client.getSeries(lib.id)) as { id: number; name: string }[];
        for (const s of series) if (!known.has(s.id)) targets.push({ id: s.id, name: s.name, libraryId: lib.id });
      }
      break;
    }
    case 'match-unmatched': {
      const libs = await client.getLibraries();
      const rows = getDb().select().from(schema.seriesMatches).all();
      const statusBySeries = new Map(rows.map((r) => [r.kavitaSeriesId, r.status]));
      for (const lib of libs) {
        if (jobQueue.isCancelRequested(job.id)) throw new JobCancelled();
        const series = (await client.getSeries(lib.id)) as { id: number; name: string }[];
        for (const s of series) {
          // O(1) lookup instead of a per-series rows.find scan.
          if (statusBySeries.get(s.id) !== 'matched') targets.push({ id: s.id, name: s.name, libraryId: lib.id });
        }
      }
      break;
    }
    case 'match-library': {
      const libraryId = job.payload.libraryId;
      if (libraryId === undefined) throw new Error('libraryId required');
      const series = (await client.getSeries(libraryId)) as { id: number; name: string }[];
      for (const s of series) targets.push({ id: s.id, name: s.name, libraryId });
      break;
    }
    case 'match-series': {
      const ids =
        job.payload.seriesIds?.length ? job.payload.seriesIds : job.payload.seriesId !== undefined ? [job.payload.seriesId] : [];
      if (!ids.length) throw new Error('seriesId or seriesIds required');
      for (const id of ids) targets.push(await byId(id));
      break;
    }
    case 'sync-series': {
      const ids = job.payload.seriesIds?.length ? job.payload.seriesIds : [];
      if (ids.length) {
        for (const id of ids) targets.push(await byId(id));
      } else {
        const libraryId = job.payload.libraryId;
        if (libraryId === undefined) throw new Error('seriesIds or libraryId required');
        const rows = getDb().select().from(schema.seriesMatches).all();
        const matchedIds = new Set(rows.filter((r) => r.status === 'matched').map((r) => r.kavitaSeriesId));
        const series = (await client.getSeries(libraryId)) as { id: number; name: string }[];
        for (const s of series) {
          if (matchedIds.has(s.id)) {
            targets.push({ id: s.id, name: s.name, libraryId });
          }
        }
      }
      break;
    }
    case 'clear-overrides': {
      const libIds = job.payload.libraryId !== undefined ? [job.payload.libraryId] : [];
      for (const libId of libIds) {
        getDb().delete(schema.libraryOverrides).where(eq(schema.libraryOverrides.libraryId, libId)).run();
      }
      summary.cleared = libIds.length;
      return summary;
    }
    default:
      throw new Error('Unknown job type: ' + job.type);
  }

  // Every series can match against the local MangaDex adult catalog, which
  // covers chapterless titles invisible to live search; flagged-mature series
  // fuzzily, others only on exact title match (see catalogCandidates). Detect
  // maturity first; batch jobs refresh the catalog inline when empty or stale
  // (single-series jobs never block on a multi-minute build).
  if (getCredentialMap().enabledProviders.includes('mangadex')) {
    let matureCount = 0;
    // Bounded concurrency — sequential metadata calls took 20-60 s on large
    // libraries before matching could even start.
    const METADATA_CONCURRENCY = 5;
    let nextTarget = 0;
    const detectMaturity = async (): Promise<void> => {
      while (nextTarget < targets.length) {
        const t = targets[nextTarget++];
        try {
          if (isMatureAgeRating((await client.getSeriesMetadata(t.id)).ageRating)) {
            t.mature = true;
            matureCount++;
          }
        } catch {
          /* series without a metadata row yet */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(METADATA_CONCURRENCY, targets.length) }, () => detectMaturity()));
    log('info', `${matureCount} of ${targets.length} target(s) flagged mature`);
    if (catalogNeedsRefresh()) {
      if (job.type === 'match-series') {
        log('warn', 'MangaDex adult catalog is empty or stale; exact-title catalog matches are unavailable until it is built. Build it from Settings → Metadata providers.');
      } else {
        log('info', 'Refreshing MangaDex adult catalog before matching...');
        await refreshCatalog({
          log,
          onProgress: (current, total) => jobQueue.setProgress(job.id, current, total),
          isCancelled: () => jobQueue.isCancelRequested(job.id),
        });
      }
    }
  }
  jobQueue.setProgress(job.id, 0, targets.length);
  log('info', `Processing ${targets.length} series`);

  const force = job.type === 'sync-series';
  for (let i = 0; i < targets.length; i++) {
    if (jobQueue.isCancelRequested(job.id)) throw new JobCancelled();
    const t = targets[i];
    const r = await matchAndApply(client, t, t.libraryId, force, log);
    summary.processed++;
    if (r.matched && r.errors.length === 0) summary.matched++;
    if (r.errors.length > 0) summary.failed++;
    jobQueue.setProgress(job.id, i + 1, targets.length);
  }

  return summary;
}