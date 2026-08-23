import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { allProviderIds, getProvider } from '../providers/registry.js';
import type { ProviderCredentials } from '../providers/types.js';

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

/** Ordered global provider priorities. */
export function getProviderPriorities(): string[] {
  const db = getDb();
  const rows = db.select().from(schema.providerPriorities).all();
  if (rows.length === 0) return allProviderIds();
  const map = new Map(rows.map((r) => [r.providerId, r.position]));
  return allProviderIds()
    .filter((id) => map.has(id))
    .sort((a, b) => (map.get(a) ?? 0) - (map.get(b) ?? 0));
}

export function setProviderPriorities(orderedIds: string[]): void {
  const db = getDb();
  db.delete(schema.providerPriorities).run();
  for (const [i, id] of orderedIds.entries()) {
    db.insert(schema.providerPriorities).values({ providerId: id, position: i }).run();
  }
}

export function getKavitaConnection(): KavitaConnection {
  const db = getDb();
  const row = db.select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, 'kavita')).get();
  if (!row) return { baseUrl: '', apiKey: '' };
  return JSON.parse(row.valueJson) as KavitaConnection;
}

export function setKavitaConnection(conn: KavitaConnection): void {
  const db = getDb();
  db.insert(schema.keyValueStore)
    .values({ key: 'kavita', valueJson: JSON.stringify(conn) })
    .onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson: JSON.stringify(conn) } })
    .run();
}

export function getProviderSettings(): Record<string, ProviderSetting> {
  const db = getDb();
  const out: Record<string, ProviderSetting> = {};
  for (const p of allProviderIds()) {
    const row = db.select().from(schema.providerCredentials).where(eq(schema.providerCredentials.providerId, p)).get();
    out[p] = {
      providerId: p,
      enabled: row?.enabled ?? true,
      credentials: row ? (JSON.parse(row.credentialsJson) as ProviderCredentials) : {},
    };
  }
  return out;
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
  const db = getDb();
  const row = db.select().from(schema.libraryOverrides).where(eq(schema.libraryOverrides.libraryId, libraryId)).get();
  if (!row) return null;
  return {
    libraryId,
    priority: JSON.parse(row.priorityJson),
    autoMatch: row.autoMatch,
  };
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
}

/** Effective provider order for a library (override-aware, enabled providers only). */
export function providerOrderFor(libraryId?: number): string[] {
  const { enabledProviders } = getCredentialMap();
  const base =
    libraryId !== undefined ? getLibraryOverride(libraryId)?.priority ?? getProviderPriorities() : getProviderPriorities();
  return base.filter((id) => enabledProviders.includes(id));
}

export function clearLibraryOverrides(libraryIds: number[]): void {
  const db = getDb();
  for (const id of libraryIds) {
    db.delete(schema.libraryOverrides).where(eq(schema.libraryOverrides.libraryId, id)).run();
  }
}

export function getAllLibraryOverrides(): LibraryOverride[] {
  const db = getDb();
  return db
    .select()
    .from(schema.libraryOverrides)
    .all()
    .map((r) => ({
      libraryId: r.libraryId,
      priority: JSON.parse(r.priorityJson),
      autoMatch: r.autoMatch,
    }));
}

/** Polling interval (minutes) for detecting new series in Kavita. 0 disables. */
export function getPollInterval(): number {
  const db = getDb();
  const row = db.select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, 'pollInterval')).get();
  return row ? Number(JSON.parse(row.valueJson)) : 15;
}

export function setPollInterval(minutes: number): void {
  const db = getDb();
  db.insert(schema.keyValueStore)
    .values({ key: 'pollInterval', valueJson: JSON.stringify(minutes) })
    .onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson: JSON.stringify(minutes) } })
    .run();
}

/** Notification delivery configuration. */
export interface NotificationSettings {
  discord: { enabled: boolean; webhookUrl: string };
}

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  discord: { enabled: false, webhookUrl: '' },
};

/**
 * Validate and normalize a stored or submitted notification config. Returns
 * null when the shape is wrong so callers can reject (400) or fall back to
 * defaults instead of crashing on missing fields.
 */
export function parseNotificationSettings(v: unknown): NotificationSettings | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const discord = o.discord as Record<string, unknown> | undefined;
  if (!discord || typeof discord.enabled !== 'boolean' || typeof discord.webhookUrl !== 'string') return null;
  return {
    discord: { enabled: discord.enabled, webhookUrl: discord.webhookUrl },
  };
}

export function getNotificationSettings(): NotificationSettings {
  const db = getDb();
  const row = db.select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, 'notifications')).get();
  if (!row) return structuredClone(DEFAULT_NOTIFICATIONS);
  try {
    const parsed = parseNotificationSettings(JSON.parse(row.valueJson));
    if (parsed) return parsed;
  } catch {
    // malformed row — fall through to defaults
  }
  return structuredClone(DEFAULT_NOTIFICATIONS);
}

export function setNotificationSettings(s: NotificationSettings): void {
  const db = getDb();
  db.insert(schema.keyValueStore)
    .values({ key: 'notifications', valueJson: JSON.stringify(s) })
    .onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson: JSON.stringify(s) } })
    .run();
}

/** Output format for downloaded galleries. */
export type DownloadFormat = 'cbz' | 'folder';

/** Doujinshi downloader configuration. */
export interface DownloaderSettings {
  /** Directory galleries are written to (absolute path). */
  downloadDirectory: string;
  /** Save as compressed .cbz archive or a raw image folder. */
  format: DownloadFormat;
  /** Max number of galleries downloaded in parallel. */
  maxConcurrentDownloads: number;
  /** Max concurrent image requests within a single gallery. */
  maxImageConcurrency: number;
  /** Delay (ms) between individual image requests to avoid rate limits. */
  requestDelayMs: number;
  /** Trigger a Kavita library scan after a download completes. */
  autoSyncKavita: boolean;
  /** Optional nhentai.net API key for higher rate limits. Falls back to the NHENTAI_API_KEY env var when empty. */
  nhentaiApiKey: string;
  /** Tag names to exclude from all NHentai searches (e.g. "loli", "big breasts"). */
  nhentaiBannedTags: string[];
}

export const DEFAULT_DOWNLOADER: DownloaderSettings = {
  downloadDirectory: '',
  format: 'cbz',
  maxConcurrentDownloads: 2,
  maxImageConcurrency: 4,
  requestDelayMs: 150,
  autoSyncKavita: false,
  nhentaiApiKey: '',
  nhentaiBannedTags: [],
};

export function getDownloaderSettings(): DownloaderSettings {
  const db = getDb();
  const row = db.select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, 'downloader')).get();
  if (!row) return { ...DEFAULT_DOWNLOADER };
  const s: DownloaderSettings = { ...DEFAULT_DOWNLOADER, ...(JSON.parse(row.valueJson) as Partial<DownloaderSettings>) };
  // Guard against stale/malformed rows so callers always get a string array.
  if (!Array.isArray(s.nhentaiBannedTags)) s.nhentaiBannedTags = [];
  return s;
}

export function setDownloaderSettings(s: DownloaderSettings): void {
  const db = getDb();
  db.insert(schema.keyValueStore)
    .values({ key: 'downloader', valueJson: JSON.stringify(s) })
    .onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson: JSON.stringify(s) } })
    .run();
}

export { getProvider };
