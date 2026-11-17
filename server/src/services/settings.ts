import { eq } from 'drizzle-orm';
import { switchKavitaState } from './kavitaState.js';
import { getDb, schema } from '../db/index.js';
import { allProviderIds, getProvider } from '../providers/registry.js';
import type { ProviderCredentials } from '../providers/types.js';
import path from 'node:path';
import type { LibraryPathMapping } from '../lib/cbz.js';
import { createHash } from 'node:crypto';
import type { NotificationSettings } from '../contracts/notifications.js';

export interface KavitaConnection {
  baseUrl: string;
  apiKey: string;
}

export interface ProviderSetting {
  providerId: string;
  enabled: boolean;
  credentials: ProviderCredentials;
}

export interface LibraryOverride {
  libraryId: number;
  priority: string[];
  autoMatch: boolean;
}

/** JSON.parse that returns null on malformed input instead of throwing. */
function safeParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Write-invalidated read-through cache for the settings getters. Only
 * tables/keys this module exclusively writes are cached (grep-verified):
 * foreign key_value_store keys ('app-auth' in auth.ts, the recommendation
 * rows in recommendations.ts) stay uncached, and executor.ts deletes
 * library_overrides through clearLibraryOverrides below, so no writer
 * bypasses the invalidation.
 */
const settingsCache = new Map<string, unknown>();

/**
 * Read-through: load on a miss, clone on a hit so a caller can never mutate
 * the cached value (every getter used to return a fresh parse per call).
 */
function cachedSetting<T>(key: string, clone: (v: T) => T, load: () => T): T {
  const hit = settingsCache.get(key);
  if (hit !== undefined) return clone(hit as T);
  const value = load();
  settingsCache.set(key, value);
  return clone(value);
}
/** Ordered global provider priorities. */
export function getProviderPriorities(): string[] {
  return cachedSetting('provider-priorities', (v) => [...v], () => {
    const db = getDb();
    const rows = db.select().from(schema.providerPriorities).all();
    if (rows.length === 0) return allProviderIds();
    const map = new Map(rows.map((r) => [r.providerId, r.position]));
    const known = allProviderIds()
      .filter((id) => map.has(id))
      .sort((a, b) => (map.get(a) ?? 0) - (map.get(b) ?? 0));
    // Providers added to the registry after priorities were last saved have no
    // stored position; append them in canonical order so they are still tried
    // (at the end) instead of being silently excluded from matching.
    for (const id of allProviderIds()) {
      if (!map.has(id)) known.push(id);
    }
    return known;
  });
}

export function setProviderPriorities(orderedIds: string[]): void {
  const db = getDb();
  db.transaction(tx => {
    tx.delete(schema.providerPriorities).run();
    for (const [i, id] of orderedIds.entries()) tx.insert(schema.providerPriorities).values({ providerId: id, position: i }).run();
  });
  settingsCache.delete('provider-priorities');
}

export function getKavitaConnection(): KavitaConnection {
  return cachedSetting('kavita-connection', (v) => ({ ...v }), () => {
    const db = getDb();
    const row = db.select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, 'kavita')).get();
    if (!row) return { baseUrl: '', apiKey: '' };
    return JSON.parse(row.valueJson) as KavitaConnection;
  });
}

export function setKavitaConnection(conn: KavitaConnection): void {
  const db = getDb();
  const previous = getKavitaConnection();
  db.transaction(() => {
    switchKavitaState(previous.baseUrl, conn.baseUrl);
    db.insert(schema.keyValueStore)
      .values({ key: 'kavita', valueJson: JSON.stringify(conn) })
      .onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson: JSON.stringify(conn) } })
      .run();
  });
  for (const key of settingsCache.keys()) if (key.startsWith('library-override:')) settingsCache.delete(key);
  settingsCache.delete('kavita-connection');
  notifySettingChange('kavita-connection');
}

export function getProviderSettings(): Record<string, ProviderSetting> {
  return cachedSetting('provider-settings', (v) => structuredClone(v), () => {
    const db = getDb();
    const out: Record<string, ProviderSetting> = {};
    for (const p of allProviderIds()) {
      const row = db.select().from(schema.providerCredentials).where(eq(schema.providerCredentials.providerId, p)).get();
      out[p] = {
        providerId: p,
        enabled: row?.enabled ?? true,
        credentials: row ? (safeParseJson<ProviderCredentials>(row.credentialsJson) ?? {}) : {},
      };
    }
    return out;
  });
}

export function setProviderSetting(providerId: string, setting: Partial<ProviderSetting>): void {
  const existing = getProviderSettings()[providerId] ?? {
    providerId,
    enabled: true,
    credentials: {},
  };
  const merged: ProviderSetting = {
    providerId,
    enabled: setting.enabled ?? existing.enabled,
    credentials: setting.credentials ?? existing.credentials,
  };
  const db = getDb();
  db.insert(schema.providerCredentials)
    .values({
      providerId,
      credentialsJson: JSON.stringify(merged.credentials),
      enabled: merged.enabled,
    })
    .onConflictDoUpdate({
      target: schema.providerCredentials.providerId,
      set: {
        credentialsJson: JSON.stringify(merged.credentials),
        enabled: merged.enabled,
      },
    })
    .run();
  settingsCache.delete('provider-settings');
}

/** Credentials map for the auto-matcher (enabled providers only). */
export function getCredentialMap(): {
  credentials: Record<string, ProviderCredentials>;
  enabledProviders: string[];
} {
  const settings = getProviderSettings();
  const credentials: Record<string, ProviderCredentials> = {};
  const enabledProviders: string[] = [];
  for (const [id, s] of Object.entries(settings)) {
    if (s.enabled) {
      enabledProviders.push(id);
      credentials[id] = s.credentials;
    }
  }
  return { credentials, enabledProviders };
}

export function getLibraryOverride(libraryId: number): LibraryOverride | null {
  // Per-library key: called once per series inside the match loop.
  return cachedSetting(`library-override:${libraryId}`, (v) => structuredClone(v), () => {
    const db = getDb();
    const row = db.select().from(schema.libraryOverrides).where(eq(schema.libraryOverrides.libraryId, libraryId)).get();
    if (!row) return null;
    const priority = safeParseJson<string[]>(row.priorityJson);
    if (!priority) return null; // malformed override — fall back to global priorities
    return {
      libraryId,
      priority,
      autoMatch: row.autoMatch,
    };
  });
}

export function setLibraryOverride(lib: LibraryOverride): void {
  const db = getDb();
  db.insert(schema.libraryOverrides)
    .values({
      libraryId: lib.libraryId,
      priorityJson: JSON.stringify(lib.priority),
      autoMatch: lib.autoMatch,
    })
    .onConflictDoUpdate({
      target: schema.libraryOverrides.libraryId,
      set: {
        priorityJson: JSON.stringify(lib.priority),
        autoMatch: lib.autoMatch,
      },
    })
    .run();
  settingsCache.delete(`library-override:${lib.libraryId}`);
}

/** Effective provider order for a library (override-aware, enabled providers only). */
export function providerOrderFor(libraryId?: number, enabledProviders?: string[]): string[] {
  // Callers that already fetched the credential map may pass its enabled list
  // to avoid a second full scan of the provider settings.
  const enabled = enabledProviders ?? getCredentialMap().enabledProviders;
  const base =
    libraryId !== undefined ? getLibraryOverride(libraryId)?.priority ?? getProviderPriorities() : getProviderPriorities();
  return base.filter((id) => enabled.includes(id));
}

export function clearLibraryOverrides(libraryIds: number[]): void {
  const db = getDb();
  for (const id of libraryIds) {
    db.delete(schema.libraryOverrides).where(eq(schema.libraryOverrides.libraryId, id)).run();
    settingsCache.delete(`library-override:${id}`);
  }
}

export function getAllLibraryOverrides(): LibraryOverride[] {
  const db = getDb();
  const out: LibraryOverride[] = [];
  for (const r of db.select().from(schema.libraryOverrides).all()) {
    const priority = safeParseJson<string[]>(r.priorityJson);
    if (!priority) continue; // skip malformed rows rather than crashing the settings page
    out.push({ libraryId: r.libraryId, priority, autoMatch: r.autoMatch });
  }
  return out;
}

const DEFAULT_POLL_INTERVAL_HOURS = 12;
export const MAX_POLL_INTERVAL_HOURS = 24 * 24;

/** Polling interval (hours) for detecting new series in Kavita. 0 disables. */
export function getPollIntervalHours(): number {
  return cachedSetting('poll-interval', (v) => v, () => {
    const db = getDb();
    const row = db.select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, 'pollIntervalHours')).get();
    if (!row) return DEFAULT_POLL_INTERVAL_HOURS;
    const parsed = Number(safeParseJson<unknown>(row.valueJson));
    return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, MAX_POLL_INTERVAL_HOURS) : DEFAULT_POLL_INTERVAL_HOURS;
  });
}

export function setPollIntervalHours(hours: number): void {
  const safeHours = Math.min(Math.max(0, hours), MAX_POLL_INTERVAL_HOURS);
  const db = getDb();
  db.insert(schema.keyValueStore)
    .values({ key: 'pollIntervalHours', valueJson: JSON.stringify(safeHours) })
    .onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson: JSON.stringify(safeHours) } })
    .run();
  settingsCache.delete('poll-interval');
  notifySettingChange('poll-interval');
}

const DEFAULT_WATCHED_SEARCH_INTERVAL_MINUTES = 15;
export const MAX_WATCHED_SEARCH_INTERVAL_MINUTES = 24 * 60;

/** Interval (minutes) at which watched searches are re-checked. 0 disables auto-checks. */
export function getWatchedSearchIntervalMinutes(): number {
  return cachedSetting('watched-search-interval', (v) => v, () => {
    const db = getDb();
    const row = db.select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, 'watchedSearchIntervalMinutes')).get();
    if (!row) return DEFAULT_WATCHED_SEARCH_INTERVAL_MINUTES;
    const parsed = Number(safeParseJson<unknown>(row.valueJson));
    return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, MAX_WATCHED_SEARCH_INTERVAL_MINUTES) : DEFAULT_WATCHED_SEARCH_INTERVAL_MINUTES;
  });
}

export function setWatchedSearchIntervalMinutes(minutes: number): void {
  const safeMinutes = Math.min(Math.max(0, minutes), MAX_WATCHED_SEARCH_INTERVAL_MINUTES);
  const db = getDb();
  db.insert(schema.keyValueStore)
    .values({ key: 'watchedSearchIntervalMinutes', valueJson: JSON.stringify(safeMinutes) })
    .onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson: JSON.stringify(safeMinutes) } })
    .run();
  settingsCache.delete('watched-search-interval');
  notifySettingChange('watched-search-interval');
}

type SettingListener = () => void;
const settingListeners = new Map<string, Set<SettingListener>>();

/** Subscribe to a cached setting changing; returns an unsubscribe function. */
export function onSettingChange(key: string, listener: SettingListener): () => void {
  const listeners = settingListeners.get(key);
  if (listeners) listeners.add(listener);
  else settingListeners.set(key, new Set([listener]));
  return () => settingListeners.get(key)?.delete(listener);
}

/** Notify the runtime schedulers immediately when a configured cadence changes. */
function notifySettingChange(key: string): void {
  for (const listener of settingListeners.get(key) ?? []) listener();
}

export type { NotificationSettings } from '../contracts/notifications.js';

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  discord: { enabled: false, webhookUrl: '' }, revision: 0, destinationIdentity: '',
};
const destinationIdentity = (url: string) => url ? createHash('sha256').update(url).digest('hex') : '';

/** Legacy stored Discord-only settings remain valid; HTTP writes require revision review. */
export function parseNotificationSettings(v: unknown): NotificationSettings | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some(key => !['discord', 'revision', 'destinationIdentity'].includes(key))) return null;
  const discord = o.discord as Record<string, unknown> | undefined;
  if (!discord || Object.keys(discord).some(key => !['enabled', 'webhookUrl'].includes(key)) || typeof discord.enabled !== 'boolean' || typeof discord.webhookUrl !== 'string') return null;
  if (o.revision !== undefined && (!Number.isSafeInteger(o.revision) || Number(o.revision) < 0)) return null;
  return { discord: { enabled: discord.enabled, webhookUrl: discord.webhookUrl.trim() },
    revision: Number(o.revision ?? 0), destinationIdentity: destinationIdentity(discord.webhookUrl.trim()) };
}

export class NotificationSettingsConflict extends Error {}
export function getNotificationSettings(): NotificationSettings {
  return cachedSetting('notifications', v => structuredClone(v), () => {
    const db = getDb();
    const row = db.select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, 'notifications')).get();
    const parsed = row ? parseNotificationSettings(safeParseJson(row.valueJson)) : null;
    return parsed ?? structuredClone(DEFAULT_NOTIFICATIONS);
  });
}

export function setNotificationSettings(s: NotificationSettings | { discord: NotificationSettings['discord'] }, expectedRevision?: number): NotificationSettings {
  const previous = getNotificationSettings();
  if (expectedRevision !== undefined && expectedRevision !== previous.revision) throw new NotificationSettingsConflict('Notification settings changed. Refresh and review the destination again.');
  const settings = parseNotificationSettings({ ...previous, ...s });
  if (!settings) throw new Error('Invalid notification settings');
  settings.revision = previous.revision + 1;
  const db = getDb();
  db.insert(schema.keyValueStore).values({ key: 'notifications', valueJson: JSON.stringify(settings) })
      .onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson: JSON.stringify(settings) } }).run();
  settingsCache.delete('notifications');
  notifySettingChange('notifications');
  return settings;
}

/** Output format for downloaded galleries. */
export type DownloadFormat = 'cbz' | 'folder';

/** Doujinshi downloader configuration. */
export interface DownloaderSettings {
  /** Directory galleries are written to (absolute path). */
  downloadDirectory: string;
  /** Kavita library roots mapped to folders accessible by H-Tosho. */
  libraryPathMappings?: LibraryPathMapping[];
  /** Save as compressed .cbz archive or a raw image folder. */
  format: DownloadFormat;
  /** Max number of galleries downloaded in parallel. */
  maxConcurrentDownloads: number;
  /** Max concurrent image requests within a single gallery. */
  maxImageConcurrency: number;
  /** Delay (ms) between individual image requests to avoid rate limits. */
  requestDelayMs: number;
  /** Legacy preference retained for stored-settings compatibility; downloads now always discover review candidates. */
  autoSyncKavita: boolean;
  /** Optional nhentai.net API key for higher rate limits. Falls back to the NHENTAI_API_KEY env var when empty. */
  nhentaiApiKey: string;
  /** Tag names to exclude from all NHentai searches (e.g. "loli", "big breasts"). */
  nhentaiBannedTags: string[];
  /** Tag names to exclude from all Hitomi searches (e.g. "loli", "artist:foo"). */
  hitomiBannedTags: string[];
}

export const DEFAULT_DOWNLOADER: DownloaderSettings = {
  downloadDirectory: '',
  libraryPathMappings: [],
  format: 'cbz',
  maxConcurrentDownloads: 2,
  maxImageConcurrency: 4,
  requestDelayMs: 150,
  autoSyncKavita: false,
  nhentaiApiKey: '',
  nhentaiBannedTags: [],
  hitomiBannedTags: [],
};

/** Validate the complete downloader configuration accepted from storage or HTTP. */
export function parseDownloaderSettings(value: unknown): DownloaderSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const s = value as Record<string, unknown>;
  const mappings = s.libraryPathMappings === undefined ? [] : s.libraryPathMappings;
  if (!Array.isArray(mappings) || mappings.some((m) =>
    !m || typeof m !== 'object' || typeof m.kavitaPath !== 'string' || typeof m.localPath !== 'string'
    || !(path.posix.isAbsolute(m.kavitaPath.trim()) || path.win32.isAbsolute(m.kavitaPath.trim()))
    || !path.isAbsolute(m.localPath.trim()) || m.kavitaPath.includes('\0') || m.localPath.includes('\0')
    || m.kavitaPath.replace(/\\/g, '/').split('/').some((segment: string) => segment === '..' || segment === '.')
  )) return null;
  const libraryPathMappings: LibraryPathMapping[] = mappings.map((m) => ({ kavitaPath: m.kavitaPath.trim(), localPath: m.localPath.trim() }));
  const rootKey = (p: string) => {
    const normalized = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
  };
  if (new Set(libraryPathMappings.map((m) => rootKey(m.kavitaPath))).size !== libraryPathMappings.length) return null;
  if (
    typeof s.downloadDirectory !== 'string' ||
    (s.format !== 'cbz' && s.format !== 'folder') ||
    !Number.isInteger(s.maxConcurrentDownloads) || Number(s.maxConcurrentDownloads) < 1 || Number(s.maxConcurrentDownloads) > 10 ||
    !Number.isInteger(s.maxImageConcurrency) || Number(s.maxImageConcurrency) < 1 || Number(s.maxImageConcurrency) > 20 ||
    !Number.isFinite(s.requestDelayMs) || Number(s.requestDelayMs) < 0 || Number(s.requestDelayMs) > 60_000 ||
    typeof s.autoSyncKavita !== 'boolean' ||
    typeof s.nhentaiApiKey !== 'string' ||
    !Array.isArray(s.nhentaiBannedTags) || s.nhentaiBannedTags.some((tag) => typeof tag !== 'string') ||
    !Array.isArray(s.hitomiBannedTags) || s.hitomiBannedTags.some((tag) => typeof tag !== 'string')
  ) return null;
  return {
    downloadDirectory: s.downloadDirectory,
    libraryPathMappings,
    format: s.format,
    maxConcurrentDownloads: Number(s.maxConcurrentDownloads),
    maxImageConcurrency: Number(s.maxImageConcurrency),
    requestDelayMs: Number(s.requestDelayMs),
    autoSyncKavita: s.autoSyncKavita,
    nhentaiApiKey: s.nhentaiApiKey,
    nhentaiBannedTags: s.nhentaiBannedTags,
    hitomiBannedTags: s.hitomiBannedTags,
  };
}

export function getDownloaderSettings(): DownloaderSettings {
  return cachedSetting('downloader', (v) => structuredClone(v), () => {
    const db = getDb();
    const row = db.select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, 'downloader')).get();
    if (!row) return { ...DEFAULT_DOWNLOADER };
    const stored = safeParseJson<Partial<DownloaderSettings>>(row.valueJson);
    return parseDownloaderSettings({ ...DEFAULT_DOWNLOADER, ...stored }) ?? { ...DEFAULT_DOWNLOADER };
  });
}

export function setDownloaderSettings(s: DownloaderSettings): void {
  const db = getDb();
  db.insert(schema.keyValueStore)
    .values({ key: 'downloader', valueJson: JSON.stringify(s) })
    .onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson: JSON.stringify(s) } })
    .run();
  settingsCache.delete('downloader');
  notifySettingChange('downloader');
}

// ---------------- Recommendations ----------------

export interface RecommendationSettings {
  /** Kavita library ids excluded from the recommendation profile. */
  excludedLibraryIds: number[];
}

const DEFAULT_RECOMMENDATION_SETTINGS: RecommendationSettings = { excludedLibraryIds: [] };

export function getRecommendationSettings(): RecommendationSettings {
  return cachedSetting('recommendations', (v) => structuredClone(v), () => {
    const db = getDb();
    const row = db.select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, 'recommendations')).get();
    if (!row) return { ...DEFAULT_RECOMMENDATION_SETTINGS };
    const stored = safeParseJson<Partial<RecommendationSettings>>(row.valueJson);
    return {
      excludedLibraryIds: Array.isArray(stored?.excludedLibraryIds) ? stored.excludedLibraryIds.filter((x) => typeof x === 'number') : [],
    };
  });
}

export function setRecommendationSettings(s: RecommendationSettings): void {
  const db = getDb();
  db.insert(schema.keyValueStore)
    .values({ key: 'recommendations', valueJson: JSON.stringify(s) })
    .onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson: JSON.stringify(s) } })
    .run();
  settingsCache.delete('recommendations');
}

export { getProvider };
