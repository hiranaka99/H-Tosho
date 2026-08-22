import { getNotificationSettings } from '../services/settings.js';
import { fetchJson } from '../lib/http.js';

export interface Notification {
  title: string;
  body: string;
  coverUrl?: string;
  success: boolean;
}

const EMBED_COLOR_OK = 0x3ba55c;
const EMBED_COLOR_ERR = 0xc93636;

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

async function sendDiscord(n: Notification, webhookUrl: string): Promise<void> {
  const embed: Record<string, unknown> = {
    title: n.title,
    description: n.body,
    color: n.success ? EMBED_COLOR_OK : EMBED_COLOR_ERR,
    timestamp: new Date().toISOString(),
  };
  if (n.coverUrl) embed.thumbnail = { url: n.coverUrl };
  await fetchJson(
    webhookUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'H-Tosho', embeds: [embed] }),
    },
    8_000,
  );
}

async function sendApprise(n: Notification, appriseUrl: string): Promise<void> {
  const form = new URLSearchParams();
  form.set('url', appriseUrl);
  form.set('title', n.title);
  form.set('body', n.body);
  const base = appriseUrl.startsWith('http') ? appriseUrl.replace(/\/+$/, '') : appriseUrl;
  const endpoint = base.includes('/notify') ? base : base + '/notify';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
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