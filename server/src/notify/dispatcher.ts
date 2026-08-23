import { getNotificationSettings } from '../services/settings.js';
import { sleep } from '../lib/http.js';

export interface Notification {
  title: string;
  body: string;
  coverUrl?: string;
  success: boolean;
}

const EMBED_COLOR_OK = 0x3ba55c;
const EMBED_COLOR_ERR = 0xc93636;
/** Discord embed field limits — longer values are rejected by the API. */
const DISCORD_TITLE_MAX = 256;
const DISCORD_DESCRIPTION_MAX = 4096;
const WEBHOOK_TIMEOUT_MS = 10_000;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export async function notify(n: Notification): Promise<void> {
  const settings = getNotificationSettings();
  const tasks: Promise<unknown>[] = [];
  if (settings.discord.enabled && settings.discord.webhookUrl) {
    tasks.push(sendDiscord(n, settings.discord.webhookUrl));
  }
  if (settings.apprise.enabled && settings.apprise.url) {
    tasks.push(sendApprise(n, settings.apprise.url));
  }
  await Promise.allSettled(tasks);
}

/**
 * POST to a Discord webhook with explicit status handling: 429 is retried once
 * after the server-provided Retry-After (capped), any other non-2xx throws so
 * callers/tests see real failures instead of a silent "ok".
 */
async function postDiscord(webhookUrl: string, embed: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify({ username: 'H-Tosho', embeds: [embed] });
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(`Discord webhook unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 429 && attempt === 0) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 5_000;
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`Discord webhook HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return;
  }
}

async function sendDiscord(n: Notification, webhookUrl: string): Promise<void> {
  const embed: Record<string, unknown> = {
    title: truncate(n.title, DISCORD_TITLE_MAX),
    description: truncate(n.body, DISCORD_DESCRIPTION_MAX),
    color: n.success ? EMBED_COLOR_OK : EMBED_COLOR_ERR,
    timestamp: new Date().toISOString(),
  };
  if (n.coverUrl) embed.thumbnail = { url: n.coverUrl };
  await postDiscord(webhookUrl, embed);
}

async function sendApprise(n: Notification, appriseUrl: string): Promise<void> {
  const form = new URLSearchParams();
  form.set('url', appriseUrl);
  form.set('title', n.title);
  form.set('body', n.body);
  const base = appriseUrl.startsWith('http') ? appriseUrl.replace(/\/+$/, '') : appriseUrl;
  const endpoint = base.includes('/notify') ? base : base + '/notify';
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Apprise unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new Error('Apprise HTTP ' + res.status);
}

export async function testNotification(): Promise<{ discord: string; apprise: string }> {
  const settings = getNotificationSettings();
  const out = { discord: 'disabled', apprise: 'disabled' };
  if (settings.discord.enabled && settings.discord.webhookUrl) {
    try {
      await sendDiscord(
        { title: 'H-Tosho test', body: 'Discord webhook works.', success: true },
        settings.discord.webhookUrl,
      );
      out.discord = 'ok';
    } catch (e) {
      out.discord = e instanceof Error ? e.message : 'failed';
    }
  }
  if (settings.apprise.enabled && settings.apprise.url) {
    try {
      await sendApprise(
        { title: 'H-Tosho test', body: 'Apprise works.', success: true },
        settings.apprise.url,
      );
      out.apprise = 'ok';
    } catch (e) {
      out.apprise = e instanceof Error ? e.message : 'failed';
    }
  }
  return out;
}
