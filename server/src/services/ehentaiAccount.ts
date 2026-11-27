/**
 * Persistent E-Hentai account storage.
 *
 * The session cookies are encrypted with a provider-specific AES-256-GCM
 * envelope and kept in their own key/value record — never in the ordinary
 * `downloader` settings JSON, which GET /settings/downloader returns verbatim.
 * A random 256-bit key lives in a dedicated restricted file under DATA_DIR
 * (not derived from the session, not in SQLite). Encryption protects against
 * a database-only disclosure; it does not protect against compromise of the
 * whole data volume or server.
 *
 * The `revision` is the account identity (site + session) used for save
 * conflict detection (409) and for invalidating account-scoped runtime state
 * (preflight caches, protected media, unified search sessions). Recording
 * test access evidence does not bump it: evidence is a timestamped hint, not
 * an authorization change.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { DATA_DIR, getDb, schema } from "../db/index.js";
import {
  parseEhentaiSession,
  parseEhentaiSite,
  type EhentaiAccountView,
  type EhentaiAccessState,
  type EhentaiSessionInput,
  type EhentaiSiteAccess,
} from "../contracts/ehentai.js";
import { isEhentaiSite, type EhentaiSite } from "../contracts/doujin.js";

const STORE_KEY = "ehentai_account";
const KEY_FILE = path.join(DATA_DIR, "ehentai-account.key");

export class EhentaiAccountError extends Error {}
/** A save/delete arrived with a stale revision. */
export class EhentaiAccountConflict extends Error {}
/** The key file or ciphertext is missing/corrupt. This is a configuration
 *  error: we must never regenerate a key over ciphertext or fall back to
 *  plaintext. */
export class EhentaiAccountCryptoError extends Error {
  constructor() {
    super(
      "E-Hentai account encryption key is missing or corrupted. The stored session cannot be decrypted; re-save your account cookies in Settings."
    );
    this.name = "EhentaiAccountCryptoError";
  }
}

interface StoredRecord {
  revision: number;
  site: EhentaiSite;
  /** null when no session is stored. */
  envelope: { iv: string; tag: string; ciphertext: string } | null;
  access: { eHentai: EhentaiSiteAccess; exHentai: EhentaiSiteAccess };
}

const untested: EhentaiSiteAccess = { state: "untested", testedAt: null };

// ---------------- key material ----------------

let cachedKey: Buffer | null = null;

/** Load the 256-bit envelope key, creating it (exclusively) on first use.
 *  Simultaneous creation is handled by reading the existing valid key. */
function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  let key: Buffer;
  try {
    key = fs.readFileSync(KEY_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new EhentaiAccountCryptoError();
    key = crypto.randomBytes(32);
    try {
      fs.writeFileSync(KEY_FILE, key, { flag: "wx", mode: 0o600 });
    } catch (createError) {
      if ((createError as NodeJS.ErrnoException).code === "EEXIST") {
        // A concurrent startup created it first; use it.
        key = fs.readFileSync(KEY_FILE);
      } else {
        throw createError;
      }
    }
    try {
      fs.chmodSync(KEY_FILE, 0o600);
    } catch {
      /* platforms without POSIX permissions (Windows) — best effort */
    }
  }
  if (key.length !== 32) throw new EhentaiAccountCryptoError();
  cachedKey = key;
  return key;
}

function encrypt(
  key: Buffer,
  session: EhentaiSessionInput
): StoredRecord["envelope"] {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(session), "utf8"),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decrypt(
  key: Buffer,
  envelope: StoredRecord["envelope"]
): EhentaiSessionInput | null {
  if (!envelope) return null;
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    const value: unknown = JSON.parse(plaintext.toString("utf8"));
    if (!value || typeof value !== "object") return null;
    const parsed = parseEhentaiSession(value);
    if (parsed.error || !parsed.session) return null;
    return parsed.session;
  } catch {
    throw new EhentaiAccountCryptoError();
  }
}

// ---------------- record read/write ----------------

function parseAccess(raw: unknown): EhentaiSiteAccess {
  if (!raw || typeof raw !== "object") return { ...untested };
  const value = raw as Record<string, unknown>;
  const state =
    typeof value.state === "string" &&
    [
      "untested",
      "verified",
      "denied",
      "content-warning",
      "quota-limited",
      "unavailable",
      "rate-limited",
    ].includes(value.state)
      ? value.state
      : "untested";
  return {
    state: state as EhentaiAccessState,
    testedAt:
      typeof value.testedAt === "string" && value.testedAt
        ? value.testedAt
        : null,
    message:
      typeof value.message === "string" && value.message
        ? value.message.slice(0, 500)
        : undefined,
  };
}

let cachedRecord: {
  raw: string | null;
  record: StoredRecord;
  key?: Buffer;
  session?: EhentaiSessionInput | null;
} | null = null;

function loadRecordEntry(): {
  record: StoredRecord;
  readDecrypted: () => EhentaiSessionInput | null;
} {
  const row = getDb()
    .select({ valueJson: schema.keyValueStore.valueJson })
    .from(schema.keyValueStore)
    .where(eq(schema.keyValueStore.key, STORE_KEY))
    .get();
  const raw = row?.valueJson ?? null;
  if (cachedRecord && cachedRecord.raw === raw) {
    const entry = cachedRecord;
    return {
      record: entry.record,
      readDecrypted: () => {
        if (!entry.record.envelope) return null;
        const key = loadKey();
        if (entry.key === key && entry.session !== undefined)
          return entry.session;
        const session = decrypt(key, entry.record.envelope);
        entry.key = key;
        entry.session = session;
        return session;
      },
    };
  }
  let record: StoredRecord;
  if (raw === null) {
    record = {
      revision: 0,
      site: "e-hentai",
      envelope: null,
      access: { eHentai: { ...untested }, exHentai: { ...untested } },
    };
  } else {
    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(raw);
    } catch {
      // Malformed stored record is a configuration error, not a silent reset:
      // wiping it here would discard a user's only copy of the envelope.
      throw new EhentaiAccountCryptoError();
    }
    const stored = parsedRaw as Record<string, unknown>;
    const storedAccess =
      (stored.access as Record<string, unknown> | undefined) ?? {};
    record = {
      revision:
        typeof stored.revision === "number" &&
        Number.isSafeInteger(stored.revision) &&
        stored.revision >= 0
          ? stored.revision
          : 0,
      site: isEhentaiSite(stored.site) ? stored.site : "e-hentai",
      envelope:
        stored.envelope &&
        typeof stored.envelope === "object" &&
        typeof (stored.envelope as Record<string, unknown>).iv === "string" &&
        typeof (stored.envelope as Record<string, unknown>).tag === "string" &&
        typeof (stored.envelope as Record<string, unknown>).ciphertext ===
          "string"
          ? (stored.envelope as StoredRecord["envelope"])
          : null,
      access: {
        eHentai: parseAccess(storedAccess.eHentai),
        exHentai: parseAccess(storedAccess.exHentai),
      },
    };
  }
  const entry: NonNullable<typeof cachedRecord> = { raw, record };
  cachedRecord = entry;
  return {
    record,
    readDecrypted: () => {
      if (!entry.record.envelope) return null;
      const key = loadKey();
      if (entry.key === key && entry.session !== undefined)
        return entry.session;
      const session = decrypt(key, entry.record.envelope);
      entry.key = key;
      entry.session = session;
      return session;
    },
  };
}

function loadRecord(): StoredRecord {
  return loadRecordEntry().record;
}

function saveRecord(
  record: StoredRecord,
  session?: EhentaiSessionInput | null
): void {
  const raw = JSON.stringify(record);
  getDb()
    .insert(schema.keyValueStore)
    .values({ key: STORE_KEY, valueJson: raw })
    .onConflictDoUpdate({
      target: schema.keyValueStore.key,
      set: { valueJson: raw },
    })
    .run();
  cachedRecord =
    session !== undefined
      ? { raw, record, key: cachedKey ?? undefined, session }
      : { raw, record };
}

function requireRevision(
  record: StoredRecord,
  expectedRevision: unknown
): void {
  if (
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    throw new EhentaiAccountError(
      "expectedRevision must be a nonnegative integer"
    );
  }
  if (expectedRevision !== record.revision) {
    throw new EhentaiAccountConflict(
      `Account revision is ${record.revision}; the client still expected ${expectedRevision}. Reload and try again.`
    );
  }
}

// ---------------- change notification ----------------

type AccountListener = () => void;
const accountListeners = new Set<AccountListener>();

/** Subscribe to account identity changes (site/session save, delete).
 *  Used to invalidate preflight, media, and unified-search caches. */
export function onEhentaiAccountChange(listener: AccountListener): () => void {
  accountListeners.add(listener);
  return () => {
    accountListeners.delete(listener);
  };
}

function notifyAccountChange(): void {
  for (const listener of Array.from(accountListeners)) {
    try {
      listener();
    } catch {
      /* subscribers cannot interrupt mutations */
    }
  }
}

// ---------------- public API ----------------

/** Public account view — never contains cookie values. */
export function getEhentaiAccountView(): EhentaiAccountView {
  const { record, readDecrypted } = loadRecordEntry();
  return viewFrom(record, readDecrypted);
}

/** Server-side only: the decrypted session, or null when unconfigured.
 *  Throws EhentaiAccountCryptoError when the envelope cannot be decrypted. */
export function getStoredSession(): EhentaiSessionInput | null {
  const { record, readDecrypted } = loadRecordEntry();
  if (!record.envelope) return null;
  return readDecrypted();
}

/** Has a stored session (public flag; a crypto failure reports unconfigured
 *  rather than leaking secrets — the detailed error surfaces on save/test). */
export function isAccountConfigured(): boolean {
  const { record, readDecrypted } = loadRecordEntry();
  if (!record.envelope) return false;
  try {
    return readDecrypted() !== null;
  } catch {
    return false;
  }
}

/** The family site the account prefers (record read; never decrypts). */
export function getEhentaiAccountSite(): EhentaiSite {
  return loadRecord().site;
}

/** Account identity revision (site + session). */
export function getAccountRevision(): number {
  return loadRecord().revision;
}

/**
 * Site, revision, and session from a single record read. `readSession`
 * decrypts lazily (throwing EhentaiAccountCryptoError like getStoredSession),
 * so callers can map record and decryption failures separately.
 */
export function getEhentaiAccountSnapshot(): {
  site: EhentaiSite;
  revision: number;
  readSession: () => EhentaiSessionInput | null;
} {
  const { record, readDecrypted } = loadRecordEntry();
  return {
    site: record.site,
    revision: record.revision,
    readSession: readDecrypted,
  };
}

function viewFrom(
  record: StoredRecord,
  readDecrypted?: () => EhentaiSessionInput | null
): EhentaiAccountView {
  let hasIgneous = false;
  let sessionError: string | null = null;
  if (record.envelope) {
    try {
      const session = readDecrypted
        ? readDecrypted()
        : decrypt(loadKey(), record.envelope);
      hasIgneous = session?.igneous !== undefined;
    } catch (error) {
      sessionError =
        error instanceof Error
          ? error.message
          : "The stored E-Hentai session cannot be decrypted.";
    }
  }
  return {
    site: record.site,
    revision: record.revision,
    configured: record.envelope !== null,
    hasIgneous,
    sessionError,
    eHentai: record.access.eHentai,
    exHentai: record.access.exHentai,
  };
}

export interface EhentaiSaveInput {
  site?: EhentaiSite;
  /** Full session replacement. `undefined` preserves the stored session;
   *  empty/invalid values are an error, never a deletion. */
  session?: EhentaiSessionInput;
  expectedRevision: number;
}

/** Save the site selection and/or a complete session replacement. Bumps the
 *  revision, persists, and invalidates account-scoped runtime state. */
export function saveEhentaiAccount(
  input: EhentaiSaveInput
): EhentaiAccountView {
  const { record, readDecrypted } = loadRecordEntry();
  requireRevision(record, input.expectedRevision);
  const site = parseEhentaiSite(input.site, record.site);
  if (site.error) throw new EhentaiAccountError(site.error);
  let envelope = record.envelope;
  let nextSession: EhentaiSessionInput | null | undefined;
  if (input.session !== undefined) {
    // Re-validate through the contract even though the route already did:
    // this is the persistence boundary.
    const parsed = parseEhentaiSession({
      ipb_member_id: input.session.ipb_member_id,
      ipb_pass_hash: input.session.ipb_pass_hash,
      igneous: input.session.igneous,
    });
    if (parsed.error || !parsed.session)
      throw new EhentaiAccountError(parsed.error ?? "Invalid session");
    nextSession = parsed.session;
    envelope = encrypt(loadKey(), parsed.session);
  }
  const next: StoredRecord = {
    revision: record.revision + 1,
    site: site.site!,
    envelope,
    access: record.access,
  };
  saveRecord(next, nextSession);
  notifyAccountChange();
  return viewFrom(
    next,
    nextSession !== undefined
      ? () => nextSession!
      : next.envelope === record.envelope
        ? readDecrypted
        : undefined
  );
}

/** Remove the stored session, reset access evidence, advance the revision,
 *  and invalidate account-scoped runtime state. Site selection and all
 *  unrelated settings/history are preserved. */
export function removeEhentaiAccount(
  expectedRevision: number
): EhentaiAccountView {
  const record = loadRecord();
  requireRevision(record, expectedRevision);
  const next: StoredRecord = {
    revision: record.revision + 1,
    site: record.site,
    envelope: null,
    access: { eHentai: { ...untested }, exHentai: { ...untested } },
  };
  saveRecord(next, null);
  notifyAccountChange();
  return viewFrom(next, () => null);
}

export interface EhentaiAccessUpdate {
  eHentai?: EhentaiSiteAccess;
  exHentai?: EhentaiSiteAccess;
}

/** Record timestamped access evidence from a real check. Does not bump the
 *  revision (evidence is not authorization) and is not visible in GET as a
 *  stored secret — only state + time. */
export function recordAccess(update: EhentaiAccessUpdate): void {
  const record = loadRecord();
  const next: StoredRecord = {
    ...record,
    access: {
      eHentai: update.eHentai ?? record.access.eHentai,
      exHentai: update.exHentai ?? record.access.exHentai,
    },
  };
  saveRecord(next);
}
