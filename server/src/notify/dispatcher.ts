import { getNotificationSettings } from '../services/settings.js';
import { getProvider } from '../providers/registry.js';
import { sleep } from '../lib/http.js';

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface Notification {
  title: string;
  /** Plain description line rendered above the fields. */
  description?: string;
  /** Structured embed fields; entries with empty values are dropped. */
  fields?: EmbedField[];
  coverUrl?: string;
  success: boolean;
}

const EMBED_COLOR_OK = 0x3ba55c;
const EMBED_COLOR_ERR = 0xc93636;
/** Discord embed limits — longer values are rejected by the API. */
const DISCORD_TITLE_MAX = 256;
const DISCORD_FIELD_NAME_MAX = 256;
const DISCORD_FIELD_VALUE_MAX = 1024;
const DISCORD_DESCRIPTION_MAX = 4096;
const DISCORD_FIELDS_MAX = 25;
const WEBHOOK_TIMEOUT_MS = 10_000;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
/** Human-friendly provider name for an id ("mangadex" → "MangaDex"); unknown ids pass through. */
export function providerName(id: string): string {
  return getProvider(id)?.name ?? id;
}

/** Payload property names a Kavita sync can push, mapped to human labels for notifications. */
const PUSHED_FIELD_LABELS: Record<string, string> = {
  name: 'Title',
  summary: 'Summary',
  genres: 'Genres',
  tags: 'Tags',
  writers: 'Writers',
  artists: 'Artists',
  releaseYear: 'Release year',
  language: 'Language',
  publicationStatus: 'Publication status',
  webLinks: 'Web link',
  cover: 'Cover',
};

/** "summary, tags, volumeCovers:3" → "Summary, Tags, 3 volume covers". */
export function formatPushedFields(pushed: string[]): string {
  return pushed
    .map((f) => (f.startsWith('volumeCovers:') ? `${f.slice('volumeCovers:'.length)} volume covers` : PUSHED_FIELD_LABELS[f] ?? f))
    .join(', ');
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
    color: n.success ? EMBED_COLOR_OK : EMBED_COLOR_ERR,
    timestamp: new Date().toISOString(),
    footer: { text: 'H-Tosho' },
  };
  if (n.description) embed.description = truncate(n.description, DISCORD_DESCRIPTION_MAX);
  const fields = (n.fields ?? [])
    .filter((f) => f.value.trim() !== '')
    .slice(0, DISCORD_FIELDS_MAX)
    .map((f) => {
      const out: Record<string, unknown> = { name: truncate(f.name, DISCORD_FIELD_NAME_MAX), value: truncate(f.value, DISCORD_FIELD_VALUE_MAX) };
      if (f.inline) out.inline = true;
      return out;
    });
  if (fields.length) embed.fields = fields;
  if (n.coverUrl) embed.thumbnail = { url: n.coverUrl };
  await postDiscord(webhookUrl, embed);
}


export async function testNotification(): Promise<{ discord: string }> {
  const settings = getNotificationSettings();
  const out = { discord: 'disabled' };
  if (settings.discord.enabled && settings.discord.webhookUrl) {
    try {
      await sendDiscord(
        { title: 'H-Tosho', description: 'Discord webhook works.', success: true },
        settings.discord.webhookUrl,
      );
      out.discord = 'ok';
    } catch (e) {
      out.discord = e instanceof Error ? e.message : 'failed';
    }
  }
  return out;
}
