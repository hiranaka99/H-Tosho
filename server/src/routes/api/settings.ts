import { Hono } from 'hono';
import { getProvider } from '../../providers/registry.js';
import { getNotificationSettings, getPollIntervalHours, getProviderPriorities, getWatchedSearchIntervalMinutes, parseNotificationSettings, getProviderSettings, setNotificationSettings, setPollIntervalHours, setProviderPriorities, setWatchedSearchIntervalMinutes, setProviderSetting } from '../../services/settings.js';
import { testNotification } from '../../notify/dispatcher.js';
import { getDownloaderSettings, parseDownloaderSettings, setDownloaderSettings } from '../../services/settings.js';

import { CREDENTIAL_FIELDS, errMsg } from './helpers.js';
export const api = new Hono();
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
      credentials: s.credentials };
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
    watchedSearchIntervalMinutes: getWatchedSearchIntervalMinutes() });
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
