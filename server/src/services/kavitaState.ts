import { eq, inArray, ne } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';

export function kavitaConnectionKey(baseUrl: string): string {
  const value = baseUrl.trim();
  try { return new URL(value).href.replace(/\/+$/, ''); }
  catch { return value.replace(/\/+$/, ''); }
}

interface ConnectionState {
  matches: typeof schema.seriesMatches.$inferSelect[];
  history: typeof schema.syncHistory.$inferSelect[];
  overrides: typeof schema.libraryOverrides.$inferSelect[];
  jobs: typeof schema.jobs.$inferSelect[];
  logs: typeof schema.jobLogs.$inferSelect[];
}

/** Preserve each server's local identities and history without mixing numeric IDs. */
export function switchKavitaState(previousUrl: string, nextUrl: string): boolean {
  const previous = kavitaConnectionKey(previousUrl), next = kavitaConnectionKey(nextUrl);
  if (previous === next) return false;
  const db = getDb();
  const key = (url: string) => `kavita-state:${url}`;
  const stored = db.select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, key(next))).get();
  const restored = stored ? JSON.parse(stored.valueJson) as ConnectionState : undefined;
  // The first configured server inherits legacy data already in this installation.
  if (!previous && !restored) return false;
  const scopedJobs = db.select().from(schema.jobs).where(ne(schema.jobs.type, 'check-watched-searches')).all();
  // A subquery instead of an id list: thousands of jobs would exceed SQLite's
  // bound-variable limit. Callers run this inside one transaction.
  const scopedJobIds = db.select({ id: schema.jobs.id }).from(schema.jobs).where(ne(schema.jobs.type, 'check-watched-searches'));
  if (previous) {
    const state: ConnectionState = {
      matches: db.select().from(schema.seriesMatches).all(),
      history: db.select().from(schema.syncHistory).all(),
      overrides: db.select().from(schema.libraryOverrides).all(),
      jobs: scopedJobs,
      logs: scopedJobs.length ? db.select().from(schema.jobLogs).where(inArray(schema.jobLogs.jobId, scopedJobIds)).all() : [],
    };
    const valueJson = JSON.stringify(state);
    db.insert(schema.keyValueStore).values({ key: key(previous), valueJson })
      .onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson } }).run();
  }
  db.delete(schema.seriesMatches).run();
  db.delete(schema.syncHistory).run();
  db.delete(schema.libraryOverrides).run();
  if (scopedJobs.length) db.delete(schema.jobLogs).where(inArray(schema.jobLogs.jobId, scopedJobIds)).run();
  db.delete(schema.jobs).where(ne(schema.jobs.type, 'check-watched-searches')).run();
  if (restored) {
    for (const row of restored.matches) db.insert(schema.seriesMatches).values(row).run();
    for (const row of restored.history) db.insert(schema.syncHistory).values(row).run();
    for (const row of restored.overrides) db.insert(schema.libraryOverrides).values(row).run();
    for (const row of restored.jobs) db.insert(schema.jobs).values(row).run();
    for (const row of restored.logs) db.insert(schema.jobLogs).values(row).run();
  }
  return true;
}
