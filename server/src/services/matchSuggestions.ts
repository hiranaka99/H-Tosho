import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { KavitaClient } from '../kavita/client.js';
import { autoMatch, type CandidateMatch } from '../match/autoMatcher.js';
import { AUTO_MATCH_THRESHOLD } from '../match/normalize.js';
import { getCredentialMap, getKavitaConnection, providerOrderFor } from './settings.js';
import { kavitaConnectionKey } from './kavitaState.js';

export function currentMatchConnection(): string {
  return kavitaConnectionKey(getKavitaConnection().baseUrl);
}

function candidateKey(candidate: Pick<CandidateMatch, 'providerId' | 'providerSeriesId'>): string {
  return `${candidate.providerId}:${candidate.providerSeriesId}`;
}

export function listMatchSuggestions() {
  const db = getDb(), connectionKey = currentMatchConnection();
  const statuses = new Map(db.select({ id: schema.seriesMatches.kavitaSeriesId, status: schema.seriesMatches.status }).from(schema.seriesMatches).all().map(row => [row.id, row.status]));
  const rejected = new Set(db.select().from(schema.rejectedMatchCandidates).where(eq(schema.rejectedMatchCandidates.connectionKey, connectionKey)).all().map(row => `${row.seriesId}:${candidateKey(row)}`));
  return db.select().from(schema.matchSuggestions).where(eq(schema.matchSuggestions.connectionKey, connectionKey)).all().flatMap(row => {
    if (['matched', 'syncing'].includes(statuses.get(row.seriesId) ?? '')) return [];
    const candidates: CandidateMatch[] = JSON.parse(row.candidatesJson);
    const candidate = candidates.find(item => !rejected.has(`${row.seriesId}:${candidateKey(item)}`));
    if (!candidate) return [];
    const { candidatesJson: _, ...identity } = row;
    return [{ ...identity, candidate }];
  }).sort((a, b) => b.candidate.score - a.candidate.score || a.name.localeCompare(b.name));
}

/** Reject exactly the candidate the user reviewed, even if another scan just finished. */
export function rejectMatchCandidate(seriesId: number, providerId: string, providerSeriesId: string): boolean {
  const connectionKey = currentMatchConnection(), db = getDb();
  const row = db.select().from(schema.matchSuggestions).where(and(eq(schema.matchSuggestions.connectionKey, connectionKey), eq(schema.matchSuggestions.seriesId, seriesId))).get();
  if (!row || !(JSON.parse(row.candidatesJson) as CandidateMatch[]).some(item => item.providerId === providerId && item.providerSeriesId === providerSeriesId)) return false;
  db.insert(schema.rejectedMatchCandidates).values({ connectionKey, seriesId, providerId, providerSeriesId, rejectedAt: new Date().toISOString() }).onConflictDoNothing().run();
  return true;
}

/** Undo a rejection so the same candidate can surface again. Idempotent. */
export function restoreMatchCandidate(seriesId: number, providerId: string, providerSeriesId: string): void {
  const connectionKey = currentMatchConnection(), db = getDb();
  db.delete(schema.rejectedMatchCandidates).where(and(
    eq(schema.rejectedMatchCandidates.connectionKey, connectionKey),
    eq(schema.rejectedMatchCandidates.seriesId, seriesId),
    eq(schema.rejectedMatchCandidates.providerId, providerId),
    eq(schema.rejectedMatchCandidates.providerSeriesId, providerSeriesId),
  )).run();
}

export interface MatchSuggestionTarget { id: number; name: string; libraryId: number; libraryName: string; cover?: string }

/** Search only: never creates matches, fetches full metadata, or writes to Kavita. */
export async function scanMatchSuggestions(options: {
  checkCancelled: () => void;
  progress: (current: number, total: number) => void;
  log: (level: 'info' | 'warn', message: string) => void;
  /** Already resolved targets for a download scan; other suggestions stay untouched. */
  targets?: MatchSuggestionTarget[];
  signal?: AbortSignal;
}) {
  const connection = getKavitaConnection(), connectionKey = currentMatchConnection();
  if (!connection.baseUrl || !connection.apiKey) throw new Error('Kavita is not configured');
  const { credentials, enabledProviders } = getCredentialMap();
  if (!enabledProviders.length) throw new Error('No providers enabled/configured');
  const client = new KavitaClient(connection.baseUrl, connection.apiKey), db = getDb();
  const check = () => {
    options.checkCancelled();
    if (currentMatchConnection() !== connectionKey) throw new Error('Kavita connection changed during scan. Scan again.');
  };
  const statuses = new Map(db.select({ id: schema.seriesMatches.kavitaSeriesId, status: schema.seriesMatches.status }).from(schema.seriesMatches).all().map(row => [row.id, row.status]));
  const targets: MatchSuggestionTarget[] = [];
  const scopedIds = options.targets ? new Set(options.targets.map(item => item.id)) : null;
  if (options.targets) {
    targets.push(...options.targets.filter(item => !['matched', 'syncing'].includes(statuses.get(item.id) ?? '')));
  } else {
    const libraries = await client.getLibraries();
    check();
    for (const library of libraries) {
      const series = await client.getSeries(library.id);
      check();
      for (const item of series) {
        if (['matched', 'syncing'].includes(statuses.get(item.id) ?? '')) continue;
        targets.push({ id: item.id, name: item.name, libraryId: library.id, libraryName: library.name, cover: item.cover });
      }
    }
  }
  // Only prune within the successfully resolved scope; download checks keep other galleries intact.
  const live = new Set(targets.map(item => item.id));
  for (const row of db.select().from(schema.matchSuggestions).where(eq(schema.matchSuggestions.connectionKey, connectionKey)).all()) {
    if ((!scopedIds || scopedIds.has(row.seriesId)) && !live.has(row.seriesId)) db.delete(schema.matchSuggestions).where(and(eq(schema.matchSuggestions.connectionKey, connectionKey), eq(schema.matchSuggestions.seriesId, row.seriesId))).run();
  }
  let processed = 0, failed = 0, checked = 0;
  options.progress(0, targets.length);
  // Sequential searches respect the same provider throttles as Identify.
  for (const series of targets) {
    check();
    const providerOrder = providerOrderFor(series.libraryId, enabledProviders);
    if (!providerOrder.length) { failed++; options.progress(++processed, targets.length); continue; }
    const outcome = await autoMatch(series, { providerOrder, credentials, enabledProviders, searchAll: true, signal: options.signal });
    check();
    if (outcome.searchedProviders.length) checked++;
    const candidates = outcome.candidates.filter(item => item.score >= AUTO_MATCH_THRESHOLD);
    if (Object.keys(outcome.errors).length) {
      failed++;
      options.log('warn', `${series.name}: ${Object.entries(outcome.errors).map(([provider, error]) => `${provider}: ${error}`).join('; ')}`);
    }
    const where = and(eq(schema.matchSuggestions.connectionKey, connectionKey), eq(schema.matchSuggestions.seriesId, series.id));
    if (candidates.length) {
      const value = { connectionKey, seriesId: series.id, name: series.name, libraryId: series.libraryId, libraryName: series.libraryName, cover: series.cover ?? null, candidatesJson: JSON.stringify(candidates), checkedAt: new Date().toISOString() };
      db.insert(schema.matchSuggestions).values(value).onConflictDoUpdate({ target: [schema.matchSuggestions.connectionKey, schema.matchSuggestions.seriesId], set: value }).run();
    } else if (!Object.keys(outcome.errors).length) {
      db.delete(schema.matchSuggestions).where(where).run();
    }
    options.progress(++processed, targets.length);
  }
  const matchable = listMatchSuggestions().filter(item => !scopedIds || scopedIds.has(item.seriesId)).length;
  options.log('info', `Checked ${processed} unmatched galleries; ${matchable} have candidates${failed ? `; ${failed} had provider errors` : ''}.`);
  if (processed > 0 && checked === 0) throw new Error('Providers could not complete the scan. Check provider settings and retry.');
  return { processed, matchable, failed };
}
