import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { KavitaClient } from '../kavita/client.js';
import { mapLimit } from '../lib/http.js';
import { fetchProviderMetadata } from '../match/autoMatcher.js';
import { notify, providerName } from '../notify/dispatcher.js';
import type { SeriesMetadata } from '../providers/types.js';
import { diffMatchedMetadata, matchedMetadataProjection, type MatchUpdate, type MatchUpdateChange } from '../contracts/matchUpdates.js';
import { getFieldPolicy } from './fieldPolicies.js';
import { currentMatchConnection } from './matchSuggestions.js';
import { getCredentialMap, getKavitaConnection } from './settings.js';

/**
 * Scheduled refresh of matched series. Each series is re-read from exactly the
 * provider candidate it is matched to and compared with the metadata applied
 * last. Searching never happens here, so a new or better candidate is never an
 * alert. Results are review prompts only: nothing is written to Kavita.
 */

type MatchRow = typeof schema.matchUpdates.$inferSelect;
const fingerprint = (meta: SeriesMetadata) => createHash('sha256').update(matchedMetadataProjection(meta)).digest('hex');

function parseMetadata(json: string | null | undefined): SeriesMetadata | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as SeriesMetadata;
    return value && typeof value === 'object' && typeof value.providerId === 'string' ? value : null;
  } catch { return null; }
}

interface MatchedRow { seriesId: number; providerId: string; providerSeriesId: string; score: number | null; applied: SeriesMetadata }
/** Current exact matches, with the provider metadata last applied to each. */
function matchedSeries(ids?: number[]): Map<number, MatchedRow> {
  const table = schema.seriesMatches;
  const rows = getDb().select({ seriesId: table.kavitaSeriesId, status: table.status, providerId: table.providerId, providerSeriesId: table.providerSeriesId, matchScore: table.matchScore, metadataJson: table.metadataJson })
    .from(table).where(ids ? inArray(table.kavitaSeriesId, ids) : eq(table.status, 'matched')).all();
  const out = new Map<number, MatchedRow>();
  for (const row of rows) {
    const applied = parseMetadata(row.metadataJson);
    if (row.status !== 'matched' || !row.providerId || !row.providerSeriesId || !applied) continue;
    // The stored metadata must describe this very candidate.
    if (applied.providerId !== row.providerId || String(applied.providerSeriesId) !== row.providerSeriesId) continue;
    out.set(row.seriesId, { seriesId: row.seriesId, providerId: row.providerId, providerSeriesId: row.providerSeriesId, score: row.matchScore, applied });
  }
  return out;
}

/** Pending changes for one stored refresh row, or none once the match moved on. */
function pendingChanges(row: MatchRow, match: MatchedRow | undefined): MatchUpdateChange[] {
  if (!match || match.providerId !== row.providerId || match.providerSeriesId !== row.providerSeriesId) return [];
  const latest = parseMetadata(row.latestJson);
  return latest ? diffMatchedMetadata(match.applied, latest, getFieldPolicy(row.seriesId).lockedFields) : [];
}

function toUpdate(row: MatchRow, changes: MatchUpdateChange[], score: number | null): MatchUpdate {
  const latest = parseMetadata(row.latestJson);
  return {
    seriesId: row.seriesId, name: row.name, libraryId: row.libraryId, libraryName: row.libraryName, cover: row.cover,
    providerId: row.providerId, providerSeriesId: row.providerSeriesId,
    candidateTitle: latest?.title ?? row.name, candidateCoverUrl: latest?.coverUrl ?? null, score,
    changes, detectedAt: row.detectedAt, checkedAt: row.checkedAt,
  };
}

/** Updates waiting for review. Applying, unmatching, rematching or protecting fields resolves them immediately. */
export function listMatchUpdates(): MatchUpdate[] {
  const db = getDb(), connectionKey = currentMatchConnection();
  const rows = db.select().from(schema.matchUpdates).where(eq(schema.matchUpdates.connectionKey, connectionKey)).all();
  if (!rows.length) return [];
  const matches = matchedSeries(rows.map(row => row.seriesId));
  const resolved: number[] = [];
  const items: MatchUpdate[] = [];
  for (const row of rows) {
    const changes = pendingChanges(row, matches.get(row.seriesId));
    if (!changes.length) { resolved.push(row.seriesId); continue; }
    if (row.dismissedHash === row.latestHash) continue;
    items.push(toUpdate(row, changes, matches.get(row.seriesId)?.score ?? null));
  }
  if (resolved.length) db.delete(schema.matchUpdates).where(and(eq(schema.matchUpdates.connectionKey, connectionKey), inArray(schema.matchUpdates.seriesId, resolved))).run();
  return items.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt) || a.name.localeCompare(b.name));
}

/** Hide this provider state; a later provider change surfaces again. */
export function dismissMatchUpdate(seriesId: number, dismissed: boolean): boolean {
  const table = schema.matchUpdates, where = and(eq(table.connectionKey, currentMatchConnection()), eq(table.seriesId, seriesId));
  const row = getDb().select({ latestHash: table.latestHash }).from(table).where(where).get();
  if (!row) return false;
  getDb().update(table).set({ dismissedHash: dismissed ? row.latestHash : null }).where(where).run();
  return true;
}

export interface MatchRefreshResult { [key: string]: number; processed: number; updates: number; unchanged: number; failed: number; skipped: number }

export async function refreshMatchedSeries(options: {
  checkCancelled: () => void;
  progress: (current: number, total: number) => void;
  log: (level: 'info' | 'warn' | 'success', message: string) => void;
  signal?: AbortSignal;
}): Promise<MatchRefreshResult> {
  const connection = getKavitaConnection(), connectionKey = currentMatchConnection();
  if (!connection.baseUrl || !connection.apiKey) throw new Error('Kavita is not configured');
  const client = new KavitaClient(connection.baseUrl, connection.apiKey), db = getDb();
  const check = () => {
    options.checkCancelled();
    if (currentMatchConnection() !== connectionKey) throw new Error('Kavita connection changed during refresh. Refresh again.');
  };
  // Live Kavita series supply names/covers and keep removed series out of Home.
  const libraries = await client.getLibraries();
  check();
  const listings = await mapLimit(libraries, 4, async library => { check(); return client.getSeries(library.id); });
  check();
  const live = new Map<number, { name: string; libraryId: number; libraryName: string; cover: string | null }>();
  for (const [index, library] of libraries.entries()) for (const series of listings[index]) live.set(series.id, { name: series.name, libraryId: library.id, libraryName: library.name, cover: series.cover ?? null });
  const matches = [...matchedSeries().values()].filter(match => live.has(match.seriesId));
  const table = schema.matchUpdates;
  const existing = new Map(db.select().from(table).where(eq(table.connectionKey, connectionKey)).all().map(row => [row.seriesId, row]));
  const gone = [...existing.keys()].filter(id => !matches.some(match => match.seriesId === id));
  if (gone.length) db.delete(table).where(and(eq(table.connectionKey, connectionKey), inArray(table.seriesId, gone))).run();

  const { credentials, enabledProviders } = getCredentialMap();
  const result: MatchRefreshResult = { processed: 0, updates: 0, unchanged: 0, failed: 0, skipped: 0 };
  options.progress(0, matches.length);
  // Sequential reads respect the same provider pacing as Identify and scans.
  for (const match of matches) {
    check();
    const series = live.get(match.seriesId)!;
    const where = and(eq(table.connectionKey, connectionKey), eq(table.seriesId, match.seriesId));
    if (!enabledProviders.includes(match.providerId)) {
      result.skipped++;
    } else {
      let latest: SeriesMetadata | null = null;
      try {
        latest = await fetchProviderMetadata(match.providerId, match.providerSeriesId, credentials, options.signal);
      } catch (error) {
        check();
        result.failed++;
        options.log('warn', `${series.name}: could not read ${providerName(match.providerId)} entry ${match.providerSeriesId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      check();
      if (latest) {
        // Re-read the match: an apply or unmatch may have finished during the request.
        const current = matchedSeries([match.seriesId]).get(match.seriesId);
        const changes = current && current.providerId === match.providerId && current.providerSeriesId === match.providerSeriesId
          ? diffMatchedMetadata(current.applied, latest, getFieldPolicy(match.seriesId).lockedFields) : [];
        if (!changes.length) {
          db.delete(table).where(where).run();
          result.unchanged++;
        } else {
          const latestHash = fingerprint(latest), now = new Date().toISOString(), previous = existing.get(match.seriesId);
          const sameState = previous?.latestHash === latestHash && previous.providerId === match.providerId && previous.providerSeriesId === match.providerSeriesId;
          const value = { connectionKey, seriesId: match.seriesId, providerId: match.providerId, providerSeriesId: match.providerSeriesId,
            name: series.name, libraryId: series.libraryId, libraryName: series.libraryName, cover: series.cover,
            latestHash, latestJson: JSON.stringify(latest), checkedAt: now,
            detectedAt: sameState ? previous.detectedAt : now,
            dismissedHash: sameState ? previous.dismissedHash : null, notifiedHash: sameState ? previous.notifiedHash : null };
          db.insert(table).values(value).onConflictDoUpdate({ target: [table.connectionKey, table.seriesId], set: value }).run();
          result.updates++;
          options.log('info', `${series.name}: ${changes.map(change => change.summary).join(' · ')}`);
        }
      }
    }
    options.progress(++result.processed, matches.length);
  }
  options.log(result.failed ? 'warn' : 'success', `Checked ${result.processed} matched series; ${result.updates} have provider updates${result.failed ? `; ${result.failed} could not be read` : ''}${result.skipped ? `; ${result.skipped} skipped (provider disabled)` : ''}.`);
  if (matches.length > 0 && result.failed === matches.length - result.skipped && result.failed > 0) throw new Error('Providers could not be read. Check provider settings and retry.');
  await notifyNewUpdates(connectionKey, options.log);
  return result;
}

/** One Discord message per refresh, only for provider states not announced before. */
async function notifyNewUpdates(connectionKey: string, log: (level: 'info' | 'warn' | 'success', message: string) => void): Promise<void> {
  const table = schema.matchUpdates, db = getDb();
  const fresh = listMatchUpdates().filter(item => {
    const row = db.select({ latestHash: table.latestHash, notifiedHash: table.notifiedHash }).from(table).where(and(eq(table.connectionKey, connectionKey), eq(table.seriesId, item.seriesId))).get();
    return row && row.notifiedHash !== row.latestHash;
  });
  if (!fresh.length) return;
  const markNotified = () => {
    db.update(table).set({ notifiedHash: sql`${table.latestHash}` })
      .where(and(eq(table.connectionKey, connectionKey), inArray(table.seriesId, fresh.map(item => item.seriesId)))).run();
  };
  try {
    const outcome = await notify({
      title: fresh.length === 1 ? 'Provider update for a matched series' : `Provider updates for ${fresh.length} matched series`,
      success: true,
      description: 'Review them on Home before applying anything.',
      fields: fresh.slice(0, 10).map(item => ({ name: item.name.slice(0, 200), value: item.changes.map(change => change.summary).join('\n') })),
    });
    // Disabled delivery still counts as announced: enabling Discord later never replays a backlog.
    markNotified();
    if (outcome.status === 'delivered') log('success', `Discord notification sent for ${fresh.length} provider update${fresh.length === 1 ? '' : 's'}`);
  } catch (error) {
    markNotified();
    log('warn', `Discord notification for provider updates failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
