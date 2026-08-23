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
  if (settings.discord.enabled && settings.discord.webhookUrl) {
    await sendDiscord(n, settings.discord.webhookUrl);
  }
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


export async function testNotification(): Promise<{ discord: string }> {
  const settings = getNotificationSettings();
  const out = { discord: 'disabled' };
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
  return out;
}
