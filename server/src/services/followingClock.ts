import { Temporal } from '@js-temporal/polyfill';

export function resolvedTimezone(): { timezone: string; timezoneFallback: boolean } {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (validTimezone(timezone)) return { timezone, timezoneFallback: false };
  } catch { /* Hosts without zone data use the explicit visible fallback. */ }
  return { timezone: 'UTC', timezoneFallback: true };
}
export function validTimezone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone || /^[+-]/.test(zone)) return false;
  try { Temporal.Now.zonedDateTimeISO(zone); return true; } catch { return false; }
}
export function validDigestTime(time: unknown): time is string {
  return typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);
}
/** Earlier fold occurrence, gap shifted forward by the gap's length. Never replay missed days. */
export function nextDigestOccurrence(time: string, timezone: string, now = Date.now()): string {
  const current = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timezone);
  const [hour, minute] = time.split(':').map(Number);
  let date = current.toPlainDate();
  let due = Temporal.ZonedDateTime.from({ timeZone: timezone, year: date.year, month: date.month, day: date.day, hour, minute }, { disambiguation: 'compatible' });
  if (due.epochMilliseconds <= now) {
    date = date.add({ days: 1 });
    due = Temporal.ZonedDateTime.from({ timeZone: timezone, year: date.year, month: date.month, day: date.day, hour, minute }, { disambiguation: 'compatible' });
  }
  return new Date(due.epochMilliseconds).toISOString();
}
export function digestBatchKey(timezone: string, now = Date.now()): string {
  return `${timezone}|${Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timezone).toPlainDate()}`;
}
