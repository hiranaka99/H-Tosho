/**
 * E-Hentai account JSON contract: what the Settings UI sends and what the
 * public API returns. Pure module — no storage, HTTP, or provider imports.
 *
 * The stored session itself (cookie values) is never part of any response:
 * it is accepted on PUT/POST-test and encrypted server-side. GET returns
 * flags and timestamps only.
 */

import { isEhentaiSite, type EhentaiSite } from './doujin.js';

/** Session cookies the user copies from their own logged-in browser.
 *  `ipb_member_id` + `ipb_pass_hash` are the authenticated session pair;
 *  `igneous` is required only by some ExHentai sessions. */
export interface EhentaiSessionInput {
  ipb_member_id: string;
  ipb_pass_hash: string;
  igneous?: string;
}

/** Per-field sanity bounds follow the site's actual cookie shapes: a numeric
 *  forum member ID, a 40-hex-char MD5 pass hash, a short base64 igneous blob.
 *  They catch paste errors; they are not a security gate. */
const COOKIE_MAX_LENGTHS: Record<string, number> = { ipb_member_id: 10, ipb_pass_hash: 64, igneous: 128 };
/** Control characters, NUL, and cookie delimiters are header-injection or
 *  malformed-dump markers. We do not enforce invented fixed lengths. */
const COOKIE_BAD_CHARS = /[\u0000-\u001f\u007f;,]/;

/** Validate one cookie field. Returns a sanitized (trimmed) value or an
 *  actionable error message. */
export function validateCookieField(name: string, raw: unknown, required: boolean): { value?: string; error?: string } {
  if (raw === undefined || raw === null || raw === '') {
    if (required) return { error: `${name} is required` };
    return { value: '' };
  }
  if (typeof raw !== 'string') return { error: `${name} must be a string` };
  const value = raw.trim();
  if (!value) return required ? { error: `${name} is required` } : { value: '' };
  if (value.length > (COOKIE_MAX_LENGTHS[name] ?? 8192)) return { error: `${name} is too long` };
  if (COOKIE_BAD_CHARS.test(value)) return { error: `${name} contains invalid characters — paste a single cookie value, not a raw cookie header` };
  if (name === 'ipb_member_id' && !/^\d+$/.test(value)) return { error: 'ipb_member_id must be numeric — paste the cookie value exactly as your browser shows it' };
  return { value };
}

/** Validate a complete session replacement. All three fields are accepted;
 *  empty optional fields are dropped. */
export function parseEhentaiSession(input: unknown): { session?: EhentaiSessionInput; error?: string } {
  if (input === undefined) return {}; // omission: preserve stored session
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { error: 'session must be an object' };
  const obj = input as Record<string, unknown>;
  const member = validateCookieField('ipb_member_id', obj.ipb_member_id, true);
  if (member.error) return { error: member.error };
  const hash = validateCookieField('ipb_pass_hash', obj.ipb_pass_hash, true);
  if (hash.error) return { error: hash.error };
  const igneous = validateCookieField('igneous', obj.igneous, false);
  if (igneous.error) return { error: igneous.error };
  const session: EhentaiSessionInput = { ipb_member_id: member.value!, ipb_pass_hash: hash.value! };
  if (igneous.value) session.igneous = igneous.value;
  return { session };
}

/** Classified access evidence for one family site. `testedAt` is when the
 *  evidence was last established — it is a timestamped hint, not permanent
 *  authorization. */
export type EhentaiAccessState =
  | 'untested' // no successful check recorded yet
  | 'verified' // last check confirmed usable access
  | 'denied' // upstream refused access (invalid session, no ExHentai right, or denial page)
  | 'content-warning' // age/content gate; needs the user's own confirmation upstream
  | 'quota-limited' // image/gallery quota exhausted (HTTP 509 class)
  | 'unavailable' // upstream unreachable or unexpected response
  | 'rate-limited'; // paced out; retry later

export interface EhentaiSiteAccess {
  state: EhentaiAccessState;
  testedAt: string | null;
  /** Sanitized, user-facing guidance. Never upstream bodies or headers. */
  message?: string;
}

export const EHENTAI_ACCESS_STATES: EhentaiAccessState[] = ['untested', 'verified', 'denied', 'content-warning', 'quota-limited', 'unavailable', 'rate-limited'];

export function isEhentaiAccessState(value: unknown): value is EhentaiAccessState {
  return typeof value === 'string' && (EHENTAI_ACCESS_STATES as readonly string[]).includes(value);
}

/** Public account view (GET /settings/ehentai and mutation responses).
 *  Deliberately contains no cookie values. */
export interface EhentaiAccountView {
  site: EhentaiSite;
  /** Monotonic identity revision; save conflicts compare against it (409). */
  revision: number;
  /** True when a session is stored (regardless of whether access verified). */
  configured: boolean;
  /** True when the stored session includes an `igneous` value. */
  hasIgneous: boolean;
  /**
   * Non-null when a session is stored but cannot be decrypted (missing or
   * corrupted key). An explicit configuration error — re-saving the account
   * fixes it. Never a secret.
   */
  sessionError: string | null;
  eHentai: EhentaiSiteAccess;
  exHentai: EhentaiSiteAccess;
}

/** Parse/validate the site field of a mutation request. */
export function parseEhentaiSite(raw: unknown, fallback: EhentaiSite): { site?: EhentaiSite; error?: string } {
  if (raw === undefined || raw === null) return { site: fallback };
  if (isEhentaiSite(raw)) return { site: raw };
  return { error: 'site must be "e-hentai" or "exhentai"' };
}
