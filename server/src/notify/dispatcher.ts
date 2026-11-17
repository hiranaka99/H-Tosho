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

export type NotificationOutcome = { status: 'disabled' } | { status: 'delivered'; receiptId: string | null };
export class NotificationFailure extends Error {
  constructor(message: string, readonly outcome: 'failed' | 'unknown', readonly retryable = false, readonly retryAfterMs?: number) { super(message); }
}
export async function notify(n: Notification, expected?: { revision: number; destinationIdentity: string }): Promise<NotificationOutcome> {
  const settings = getNotificationSettings();
  if (!settings.discord.enabled || !settings.discord.webhookUrl) return { status: 'disabled' };
  if (expected && (settings.revision !== expected.revision || settings.destinationIdentity !== expected.destinationIdentity)) throw new NotificationFailure('Notification settings changed before sending.', 'failed');
  return { status: 'delivered', receiptId: await sendDiscord(n, settings.discord.webhookUrl, expected !== undefined) };
}

/** A network timeout can follow acceptance. It is ambiguous, never a safe automatic replay. */
async function postDiscord(webhookUrl: string, embed: Record<string, unknown>, acknowledged: boolean): Promise<string | null> {
  let url: URL;
  try { url = new URL(webhookUrl); } catch { throw new NotificationFailure('Invalid Discord webhook URL; no request was sent.', 'failed'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new NotificationFailure('Invalid Discord webhook protocol; no request was sent.', 'failed');
  if (acknowledged) url.searchParams.set('wait', 'true');
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'H-Tosho', allowed_mentions: { parse: [] }, embeds: [embed] }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) });
  } catch {
    throw new NotificationFailure('Discord acknowledgement unavailable; the message may have been accepted.', 'unknown');
  }
  if (!res.ok) {
    const retryAfter = Number(res.headers.get('retry-after'));
    // Never include remote response bodies or webhook credentials in persisted errors.
    throw new NotificationFailure(`Discord webhook HTTP ${res.status}`, 'failed', res.status === 429 || res.status >= 500,
      res.status === 429 ? Math.min(300_000, Math.max(1_000, Number.isFinite(retryAfter) ? retryAfter * 1000 : 5_000)) : undefined);
  }
  if (!acknowledged) return null;
  const receipt = await res.json().catch(() => null) as { id?: unknown } | null;
  if (!receipt || typeof receipt.id !== 'string' || !receipt.id) throw new NotificationFailure('Discord returned no message receipt; delivery is uncertain.', 'unknown');
  return receipt.id;
}

async function sendDiscord(n: Notification, webhookUrl: string, acknowledged = false): Promise<string | null> {
  const embed: Record<string, unknown> = {
    title: truncate(n.title, DISCORD_TITLE_MAX),
    color: n.success ? EMBED_COLOR_OK : EMBED_COLOR_ERR,
    timestamp: new Date(Date.now()).toISOString(),
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
  try { return await postDiscord(webhookUrl, embed, acknowledged); }
  catch (error) {
    // Unacknowledged metadata/test sends retain their one bounded 429 retry.
    if (!acknowledged && error instanceof NotificationFailure && error.message === 'Discord webhook HTTP 429') {
      await sleep(Math.min(error.retryAfterMs ?? 5_000, 30_000));
      return postDiscord(webhookUrl, embed, false);
    }
    throw error;
  }
}


export async function testNotification(settings = getNotificationSettings()): Promise<{ discord: string }> {
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
