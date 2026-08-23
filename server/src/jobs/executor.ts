import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { KavitaClient } from '../kavita/client.js';
import {
  getAggregationOptions,
  getCredentialMap,
  getGlobalFieldConfig,
  getKavitaConnection,
  getLibraryOverride,
  getProviderPriorities,
} from '../services/settings.js';
import { autoMatch, fetchAggregatedMetadata, type CandidateMatch } from '../match/autoMatcher.js';
import { applyToKavita, fetchCover } from '../services/sync.js';
import { notify } from '../notify/dispatcher.js';
import { jobQueue, type Job, type LogFn } from './queue.js';

interface Target {
  id: number;
  name: string;
  libraryId?: number;
}

interface MatchResult {
  seriesId: number;
  title: string;
  matched: boolean;
  errors: string[];
  coverUrl?: string;
}

function providerOrderFor(libraryId?: number): string[] {
  const { enabledProviders } = getCredentialMap();
  const base =
    libraryId !== undefined ? getLibraryOverride(libraryId)?.priority ?? getProviderPriorities() : getProviderPriorities();
  return base.filter((id) => enabledProviders.includes(id));
}

function upsertMatch(r: {
  kavitaSeriesId: number;
  status: string;
  providerId: string | null;
  providerSeriesId: string | null;
  matchScore: number | null;
  metadataJson: string | null;
  errorMessage: string | null;
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
  series: { id: number; name: string },
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

  const outcome = await autoMatch(series, { providerOrder: order, credentials, enabledProviders });
  log?.('info', `${series.name}: ${outcome.candidates.length} candidate(s) across [${outcome.searchedProviders.join(', ')}]`);

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
    const fieldConfig = getGlobalFieldConfig();
    const meta = await fetchAggregatedMetadata(
      { providerId: best.providerId, providerSeriesId: best.providerSeriesId },
      { providerOrder: order, credentials, enabledProviders },
      fieldConfig,
    );
    const agg = getAggregationOptions();
    const cover = agg.replaceCover ? await fetchCover(client, meta.coverUrl) : null;
    const result = await applyToKavita(client, series.id, meta, {
      agg,
      fieldConfig: getGlobalFieldConfig(),
      cover,
      title: series.name,
    });

    const status = result.errors.length ? 'failed' : 'matched';
    upsertMatch({
      kavitaSeriesId: series.id,
      status,
      providerId: best.providerId,
      providerSeriesId: best.providerSeriesId,
      matchScore: best.score,
      metadataJson: JSON.stringify(meta),
      errorMessage: result.errors.length ? result.errors.join('; ') : null,
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

    await notify({
      title: `${force ? 'Updated' : 'Matched'}: ${series.name}`,
      body: `Matched to ${best.providerId} (${Math.round(best.score * 100)}%). Pushed: ${
        result.pushed.length ? result.pushed.join(', ') : 'none'
      }${result.errors.length ? ' — errors: ' + result.errors.join('; ') : ''}`,
      coverUrl: meta.coverUrl ?? best.coverUrl,
      success: result.errors.length === 0,
    });
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
        const series = (await client.getSeries(lib.id)) as { id: number; name: string }[];
        for (const s of series) if (!known.has(s.id)) targets.push({ id: s.id, name: s.name, libraryId: lib.id });
      }
      break;
    }
    case 'match-unmatched': {
      const libs = await client.getLibraries();
      const rows = getDb().select().from(schema.seriesMatches).all();
      for (const lib of libs) {
        const series = (await client.getSeries(lib.id)) as { id: number; name: string }[];
        for (const s of series) {
          const row = rows.find((r) => r.kavitaSeriesId === s.id);
          if (!row || row.status !== 'matched') targets.push({ id: s.id, name: s.name, libraryId: lib.id });
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
        const series = (await client.getSeries(libraryId)) as { id: number; name: string }[];
        for (const s of series) {
          if (rows.some((r) => r.kavitaSeriesId === s.id && r.status === 'matched')) {
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

  jobQueue.setProgress(job.id, 0, targets.length);
  log('info', `Processing ${targets.length} series`);

  const force = job.type === 'sync-series';
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const r = await matchAndApply(client, t, t.libraryId, force, log);
    summary.processed++;
    if (r.matched && r.errors.length === 0) summary.matched++;
    if (r.errors.length > 0) summary.failed++;
    jobQueue.setProgress(job.id, i + 1, targets.length);
  }

  return summary;
}