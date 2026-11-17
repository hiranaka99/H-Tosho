import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { getDb, schema, type Db } from '../db/index.js';
import type { DoujinSearchResult } from '../downloader/types.js';
import { notify, NotificationFailure } from '../notify/dispatcher.js';
import { advanceDigestSchedule, getNotificationSettings } from './settings.js';
import { digestBatchKey } from './followingClock.js';
import { DELIVERY_STATUSES, type DeliveryMember, type DeliveryReview, type DeliveryRetryRequest,
  type DeliveryStatus, type FollowingDelivery, type FollowingDeliveryPage, type FollowingDeliverySummary, type NotificationSettings } from '../contracts/followingDelivery.js';

type Watch = typeof schema.watchedSearches.$inferSelect;
type Event = typeof schema.followingEvents.$inferSelect;
type Delivery = typeof schema.followingDeliveries.$inferSelect;
const MAX_ATTEMPTS = 4;
const SWEEP_LIMIT = 20;
const DIGEST_LIMIT = 100;
let sweeping = false;
export class FollowingDeliveryError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) { super(message); }
}

/** Called only inside the discovery transaction; never receives a webhook credential. */
export function contributeFollowingFind(tx: Db, watch: Watch, gallery: DoujinSearchResult, foundAt: string, jobId?: number): number {
  const settings = getNotificationSettings();
  tx.insert(schema.followingEvents).values({ source: watch.source, galleryId: gallery.galleryId,
    title: gallery.title || gallery.galleryId, url: gallery.url ?? null, settingsRevision: settings.revision,
    destinationIdentity: settings.destinationIdentity, createdAt: foundAt,
    readyAt: new Date(Date.parse(foundAt) + 2_000).toISOString() }).onConflictDoNothing().run();
  const event = tx.select().from(schema.followingEvents).where(and(eq(schema.followingEvents.source, watch.source), eq(schema.followingEvents.galleryId, gallery.galleryId))).get()!;
  const added = tx.insert(schema.followingContributions).values({ eventId: event.id, watchId: watch.id,
    source: watch.source, query: watch.query, mode: watch.notificationMode, originJobId: jobId ?? null }).onConflictDoNothing().run();
  return event.status === 'pending' && added.changes > 0 ? 1 : 0;
}

/** Invalidation is permanent: pausing then resuming never revives old contributions. */
export function invalidateWatchContributions(tx: Db, watchId: number): void {
  tx.update(schema.followingContributions).set({ invalidatedAt: new Date(Date.now()).toISOString() })
    .where(and(eq(schema.followingContributions.watchId, watchId), isNull(schema.followingContributions.invalidatedAt))).run();
}

function eligibleMember(event: Event, db: Db = getDb()): { member: DeliveryMember; immediate: boolean } | undefined {
  const contributions = db.select().from(schema.followingContributions).where(and(eq(schema.followingContributions.eventId, event.id), isNull(schema.followingContributions.invalidatedAt))).all();
  const labels = new Set<string>(), watchIds: number[] = [], originJobIds = new Set<number>();
  let immediate = false;
  for (const contribution of contributions) {
    const watch = db.select().from(schema.watchedSearches).where(eq(schema.watchedSearches.id, contribution.watchId)).get();
    if (!watch || watch.pausedAt !== null || watch.source !== contribution.source || watch.query !== contribution.query
      || watch.notificationMode === 'in-app' || watch.notificationMode !== contribution.mode) continue;
    if (contribution.originJobId !== null && db.select({ status: schema.jobs.status }).from(schema.jobs).where(eq(schema.jobs.id, contribution.originJobId)).get()?.status === 'cancelled') continue;
    labels.add(watch.displayName ?? watch.query); watchIds.push(watch.id);
    if (contribution.originJobId !== null) originJobIds.add(contribution.originJobId);
    immediate ||= watch.notificationMode === 'immediate';
  }
  if (!watchIds.length) return undefined;
  return { member: { eventId: event.id, source: event.source, galleryId: event.galleryId, title: event.title,
    url: event.url, labels: [...labels].sort(), watchIds: watchIds.sort((a, b) => a - b), originJobIds: [...originJobIds].sort((a, b) => a - b) }, immediate };
}

function projectDelivery(row: Delivery): FollowingDelivery {
  const members = JSON.parse(row.payloadJson) as DeliveryMember[];
  const originJobIds = members.flatMap(member => member.originJobIds);
  return { ...row, kind: row.kind as FollowingDelivery['kind'], status: row.status as DeliveryStatus,
    members, originJobIds: [...new Set(originJobIds)].sort((a, b) => a - b) };
}

function createDelivery(tx: Db, members: DeliveryMember[], kind: 'immediate' | 'digest', status: DeliveryStatus,
  settings: NotificationSettings, now: string, batchKey: string | null = null, error: string | null = null): string {
  const id = randomUUID();
  tx.insert(schema.followingDeliveries).values({ id, kind, status, settingsRevision: settings.revision,
    destinationIdentity: settings.destinationIdentity, batchKey, payloadJson: JSON.stringify(members), createdAt: now,
    finishedAt: ['disabled', 'suppressed'].includes(status) ? now : null, error }).run();
  if (members.length) tx.update(schema.followingEvents).set({ deliveryId: id, status }).where(inArray(schema.followingEvents.id, members.map(member => member.eventId))).run();
  return id;
}

/** One immutable batch per current local day. Catch-up consumes one bounded batch, not missed days. */
export function prepareFollowingDeliveries(now = Date.now()): void {
  const settings = getNotificationSettings(), timestamp = new Date(now).toISOString();
  const db = getDb();
  db.transaction(tx => {
    const events = tx.select().from(schema.followingEvents).where(and(inArray(schema.followingEvents.status, ['pending', 'suppressed']), isNull(schema.followingEvents.deliveryId), lte(schema.followingEvents.readyAt, timestamp)))
      .orderBy(sql`EXISTS (SELECT 1 FROM following_contributions c WHERE c.event_id = ${schema.followingEvents.id} AND c.mode = 'immediate' AND c.invalidated_at IS NULL) DESC`, asc(schema.followingEvents.id)).limit(DIGEST_LIMIT + SWEEP_LIMIT).all();
    const digest: DeliveryMember[] = [];
    for (const event of events) {
      const eligible = eligibleMember(event, tx);
      const originJobIds = tx.select({ jobId: schema.followingContributions.originJobId }).from(schema.followingContributions).where(eq(schema.followingContributions.eventId, event.id)).all().flatMap(row => row.jobId === null ? [] : [row.jobId]);
      const fallback: DeliveryMember = { eventId: event.id, source: event.source, galleryId: event.galleryId, title: event.title, url: event.url, labels: [], watchIds: [], originJobIds: [...new Set(originJobIds)].sort((a, b) => a - b) };
      if (event.status !== 'pending' || event.settingsRevision !== settings.revision || event.destinationIdentity !== settings.destinationIdentity) {
        createDelivery(tx, [eligible?.member ?? fallback], 'immediate', 'suppressed', { ...settings, revision: event.settingsRevision, destinationIdentity: event.destinationIdentity }, timestamp, null, 'Settings changed; review backlog before sending.'); continue;
      }
      if (!eligible) { createDelivery(tx, [fallback], 'immediate', 'suppressed', settings, timestamp, null, 'No active notification contributions remain.'); continue; }
      if (!settings.discord.enabled || !settings.discord.webhookUrl) { createDelivery(tx, [eligible.member], eligible.immediate ? 'immediate' : 'digest', 'disabled', settings, timestamp, null, 'Discord is disabled. Old finds will not send when re-enabled.'); continue; }
      if (eligible.immediate) createDelivery(tx, [eligible.member], 'immediate', 'pending', settings, timestamp);
      else if (digest.length < DIGEST_LIMIT) digest.push(eligible.member);
    }
    if (Date.parse(settings.digest.nextDueAt) <= now) {
      const key = digestBatchKey(settings.digest.timezone, now);
      const exists = tx.select({ id: schema.followingDeliveries.id }).from(schema.followingDeliveries).where(eq(schema.followingDeliveries.batchKey, key)).get();
      if (!exists) createDelivery(tx, digest, 'digest', digest.length ? 'pending' : 'suppressed', settings, timestamp, key, digest.length ? null : 'No eligible finds at the daily cutoff.');
      advanceDigestSchedule(now);
    }
  });
}

function finishDelivery(id: string, status: DeliveryStatus, now: string, error: string | null = null, nextRetryAt: string | null = null, receiptId: string | null = null): void {
  const db = getDb();
  db.transaction(tx => {
    tx.update(schema.followingDeliveries).set({ status, finishedAt: now, error, nextRetryAt, receiptId,
      revision: sql`${schema.followingDeliveries.revision} + 1` }).where(eq(schema.followingDeliveries.id, id)).run();
    tx.update(schema.followingEvents).set({ status }).where(eq(schema.followingEvents.deliveryId, id)).run();
  });
}

function currentMembers(members: DeliveryMember[], includeNewContributions: boolean): DeliveryMember[] {
  return members.flatMap(member => {
    const event = getDb().select().from(schema.followingEvents).where(eq(schema.followingEvents.id, member.eventId)).get();
    const eligible = event && eligibleMember(event);
    if (!eligible) return [];
    // A committed batch cannot absorb a later watch contribution or change labels.
    const watchIds = includeNewContributions ? eligible.member.watchIds : eligible.member.watchIds.filter(id => member.watchIds.includes(id));
    if (!watchIds.length) return [];
    const labels = new Set(watchIds.map(id => {
      const watch = getDb().select().from(schema.watchedSearches).where(eq(schema.watchedSearches.id, id)).get()!;
      return watch.displayName ?? watch.query;
    }));
    return [{ ...member, watchIds, labels: [...labels].sort(), originJobIds: includeNewContributions ? eligible.member.originJobIds : eligible.member.originJobIds.filter(id => member.originJobIds.includes(id)) }];
  });
}

/** Bounded Discord output. Full gallery membership and all labels remain in durable status. */
export function deliveryDescription(members: DeliveryMember[]): string {
  const clip = (text: string, limit: number) => text.length <= limit ? text : text.slice(0, limit - 1) + '…';
  const escape = (text: string) => text.replace(/[\\`*_~\[\]()<>]/g, '\\$&');
  const lines = members.slice(0, 10).map(member => {
    const title = escape(clip(member.title, 100));
    const url = member.url && /^https?:\/\//i.test(member.url) ? member.url.replace(/[()\s]/g, encodeURIComponent) : null;
    return `${url && url.length < 300 ? `[${title}](${url})` : title}\nVia ${escape(clip(member.labels.join(', '), 180))}`;
  });
  return `${members.length} new ${members.length === 1 ? 'gallery' : 'galleries'}\n\n${lines.join('\n\n')}${members.length > 10 ? `\n\n+${members.length - 10} more. Full membership is saved in Following delivery history.` : ''}`;
}

export async function dispatchFollowingDeliveries(now = Date.now()): Promise<FollowingDeliverySummary> {
  if (sweeping) return followingDeliverySummary();
  sweeping = true;
  try {
    prepareFollowingDeliveries(now);
    const timestamp = new Date(now).toISOString();
    const rows = getDb().select().from(schema.followingDeliveries)
      .where(sql`${schema.followingDeliveries.status} = 'pending' OR (${schema.followingDeliveries.status} = 'failed' AND ${schema.followingDeliveries.nextRetryAt} IS NOT NULL AND ${schema.followingDeliveries.nextRetryAt} <= ${timestamp})`)
      .orderBy(asc(schema.followingDeliveries.createdAt), asc(schema.followingDeliveries.id)).limit(SWEEP_LIMIT).all();
    for (const row of rows) {
      const settings = getNotificationSettings();
      const members = JSON.parse(row.payloadJson) as DeliveryMember[];
      if (row.settingsRevision !== settings.revision || row.destinationIdentity !== settings.destinationIdentity) {
        finishDelivery(row.id, 'suppressed', timestamp, 'Destination/settings changed; review backlog before sending.'); continue;
      }
      if (!settings.discord.enabled || !settings.discord.webhookUrl) { finishDelivery(row.id, 'disabled', timestamp, 'Discord is disabled.'); continue; }
      const eligible = currentMembers(members, row.kind === 'immediate');
      if (JSON.stringify(eligible) !== JSON.stringify(members)) {
        if (row.kind === 'immediate' && eligible.length) {
          getDb().transaction(tx => {
            const replacementId = createDelivery(tx, eligible, 'immediate', 'pending', settings, timestamp);
            tx.update(schema.followingDeliveries).set({ status: 'suppressed', finishedAt: timestamp, nextRetryAt: null,
              error: `Active labels re-evaluated before send; queued as ${replacementId}`, revision: row.revision + 1 }).where(eq(schema.followingDeliveries.id, row.id)).run();
          });
        } else finishDelivery(row.id, 'suppressed', timestamp, 'Watch membership or labels changed after this immutable delivery was prepared. Review eligible backlog.');
        continue;
      }
      // Checkpoint commits BEFORE starting the external request. A restart holds it UNKNOWN.
      const claimed = getDb().update(schema.followingDeliveries).set({ status: 'dispatching', startedAt: timestamp,
        nextRetryAt: null, attempts: row.attempts + 1, revision: row.revision + 1 })
        .where(and(eq(schema.followingDeliveries.id, row.id), eq(schema.followingDeliveries.revision, row.revision), eq(schema.followingDeliveries.status, row.status))).run();
      if (!claimed.changes) continue;
      try {
        const outcome = await notify({ title: row.kind === 'digest' ? 'Following · daily digest' : 'New in Following', description: deliveryDescription(members), success: true },
          { revision: row.settingsRevision, destinationIdentity: row.destinationIdentity });
        finishDelivery(row.id, outcome.status, new Date(Date.now()).toISOString(), outcome.status === 'disabled' ? 'Discord was disabled before sending.' : null,
          null, outcome.status === 'delivered' ? outcome.receiptId : null);
      } catch (error) {
        const failure = error instanceof NotificationFailure ? error : new NotificationFailure('Unexpected delivery failure; acceptance is uncertain.', 'unknown');
        const retry = failure.outcome === 'failed' && failure.retryable && row.attempts + 1 < MAX_ATTEMPTS;
        finishDelivery(row.id, failure.outcome, new Date(Date.now()).toISOString(), failure.message,
          retry ? new Date(now + Math.max(failure.retryAfterMs ?? 0, 30_000 * 2 ** row.attempts)).toISOString() : null);
      }
    }
    return followingDeliverySummary();
  } finally { sweeping = false; }
}

export function interruptFollowingDeliveries(now = Date.now()): number {
  const rows = getDb().select({ id: schema.followingDeliveries.id }).from(schema.followingDeliveries).where(eq(schema.followingDeliveries.status, 'dispatching')).all();
  for (const row of rows) finishDelivery(row.id, 'unknown', new Date(now).toISOString(), 'Interrupted after send checkpoint; acceptance is unknown. Review before retrying.');
  return rows.length;
}

export function listFollowingDeliveries(options: { status?: string; offset?: number; limit?: number; jobId?: number } = {}): FollowingDeliveryPage {
  if (options.status && !DELIVERY_STATUSES.includes(options.status as DeliveryStatus)) throw new FollowingDeliveryError('Invalid delivery status.', 400);
  const offset = options.offset ?? 0, limit = options.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (options.jobId !== undefined && (!Number.isSafeInteger(options.jobId) || options.jobId < 1))) throw new FollowingDeliveryError('Invalid delivery paging.', 400);
  const table = schema.followingDeliveries;
  const conditions = [];
  if (options.status) conditions.push(eq(table.status, options.status));
  if (options.jobId !== undefined) conditions.push(sql`EXISTS (SELECT 1 FROM json_each(${table.payloadJson}) m, json_each(m.value, '$.originJobIds') j WHERE j.value = ${options.jobId})`);
  const where = conditions.length ? and(...conditions) : undefined;
  const total = Number(getDb().select({ n: sql<number>`count(*)` }).from(table).where(where).get()?.n ?? 0);
  const items = getDb().select().from(table).where(where).orderBy(desc(table.createdAt), desc(table.id)).limit(limit).offset(offset).all().map(projectDelivery);
  const waitingWhere = options.jobId === undefined ? undefined : sql`EXISTS (SELECT 1 FROM following_contributions c WHERE c.event_id = ${schema.followingEvents.id} AND c.origin_job_id = ${options.jobId})`;
  const waitingCount = Number(getDb().select({ n: sql<number>`count(*)` }).from(schema.followingEvents)
    .where(and(isNull(schema.followingEvents.deliveryId), eq(schema.followingEvents.status, 'pending'), waitingWhere)).get()?.n ?? 0);
  return { items, total, offset, limit, waitingCount };
}

export function followingDeliverySummary(jobId?: number): FollowingDeliverySummary {
  const summary: FollowingDeliverySummary = { pending: 0, dispatching: 0, delivered: 0, disabled: 0, suppressed: 0, failed: 0, unknown: 0 };
  const table = schema.followingDeliveries;
  const where = jobId === undefined ? undefined : sql`EXISTS (SELECT 1 FROM json_each(${table.payloadJson}) m, json_each(m.value, '$.originJobIds') j WHERE j.value = ${jobId})`;
  for (const row of getDb().select({ status: table.status, n: sql<number>`count(*)` }).from(table).where(where).groupBy(table.status).all()) summary[row.status as DeliveryStatus] = Number(row.n);
  const waitingWhere = jobId === undefined ? undefined : sql`EXISTS (SELECT 1 FROM following_contributions c WHERE c.event_id = ${schema.followingEvents.id} AND c.origin_job_id = ${jobId})`;
  summary.pending += Number(getDb().select({ n: sql<number>`count(*)` }).from(schema.followingEvents)
    .where(and(isNull(schema.followingEvents.deliveryId), eq(schema.followingEvents.status, 'pending'), waitingWhere)).get()?.n ?? 0);
  return summary;
}

export function reviewFollowingDelivery(id: string): DeliveryReview {
  const row = getDb().select().from(schema.followingDeliveries).where(eq(schema.followingDeliveries.id, id)).get();
  if (!row) throw new FollowingDeliveryError('Delivery not found.', 404);
  const delivery = projectDelivery(row), settings = getNotificationSettings();
  // Manual recovery may retain only CURRENT eligible labels, never revive invalidated contributions.
  const eligibleMembers = delivery.members.flatMap(member => {
    const event = getDb().select().from(schema.followingEvents).where(eq(schema.followingEvents.id, member.eventId)).get();
    const eligible = event?.deliveryId === id && eligibleMember(event);
    return eligible ? [{ ...eligible.member, ...(member.possibleDuplicate ? { possibleDuplicate: true } : {}) }] : [];
  });
  const watchRevisions = [...new Set(eligibleMembers.flatMap(member => member.watchIds))].sort((a, b) => a - b).map(id => {
    const watch = getDb().select({ revision: schema.watchedSearches.revision }).from(schema.watchedSearches).where(eq(schema.watchedSearches.id, id)).get()!;
    return [id, watch.revision];
  });
  const membershipRevision = createHash('sha256').update(JSON.stringify({ eligibleMembers, watchRevisions })).digest('hex');
  return { delivery, settingsRevision: settings.revision, destinationIdentity: settings.destinationIdentity,
    enabled: settings.discord.enabled && Boolean(settings.discord.webhookUrl), eligibleMembers, membershipRevision, approvalId: randomUUID(), possibleDuplicate: row.status === 'unknown' || row.status === 'delivered' || delivery.members.some(member => member.possibleDuplicate === true) };
}

export function retryFollowingDelivery(id: string, request: DeliveryRetryRequest): FollowingDelivery {
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !['expectedRevision', 'settingsRevision', 'destinationIdentity', 'membershipRevision', 'approvalId', 'acknowledgeDuplicate', 'acknowledgeDestinationChange'].includes(key))
    || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 || !Number.isSafeInteger(request.settingsRevision) || request.settingsRevision < 0 || typeof request.destinationIdentity !== 'string' || typeof request.membershipRevision !== 'string'
    || typeof request.approvalId !== 'string' || !/^[\da-f-]{36}$/i.test(request.approvalId) || request.acknowledgeDestinationChange !== true || typeof request.acknowledgeDuplicate !== 'boolean') throw new FollowingDeliveryError('Provide a reviewed destination and valid retry approval.', 400);
  return getDb().transaction(tx => {
    const previousApproval = tx.select().from(schema.followingDeliveryApprovals).where(eq(schema.followingDeliveryApprovals.id, request.approvalId)).get();
    if (previousApproval) {
      if (previousApproval.originalId !== id) throw new FollowingDeliveryError('Approval already used for another delivery.', 409);
      return projectDelivery(tx.select().from(schema.followingDeliveries).where(eq(schema.followingDeliveries.id, previousApproval.deliveryId)).get()!);
    }
    const existingRecovery = tx.select().from(schema.followingDeliveryApprovals).where(eq(schema.followingDeliveryApprovals.originalId, id)).get();
    if (existingRecovery) throw new FollowingDeliveryError(`Recovery already queued as ${existingRecovery.deliveryId}; review that delivery instead.`, 409);
    const review = reviewFollowingDelivery(id), settings = getNotificationSettings();
    if (review.delivery.revision !== request.expectedRevision || settings.revision !== request.settingsRevision || settings.destinationIdentity !== request.destinationIdentity || review.membershipRevision !== request.membershipRevision) throw new FollowingDeliveryError('Delivery, watch membership or destination changed. Reload review.', 409);
    if (['pending', 'dispatching'].includes(review.delivery.status) || (review.delivery.status === 'failed' && review.delivery.nextRetryAt)) throw new FollowingDeliveryError('Delivery is already queued or retrying.', 409);
    if (!review.enabled || !review.eligibleMembers.length) throw new FollowingDeliveryError('No eligible current destination/watch contributions remain.', 409);
    if (review.possibleDuplicate && !request.acknowledgeDuplicate) throw new FollowingDeliveryError('Acknowledge that this resend may duplicate an accepted message.', 409);
    const now = new Date(Date.now()).toISOString();
    const members = review.possibleDuplicate ? review.eligibleMembers.map(member => ({ ...member, possibleDuplicate: true })) : review.eligibleMembers;
    const newId = createDelivery(tx, members, review.delivery.kind, 'pending', settings, now);
    tx.update(schema.followingDeliveries).set({ status: 'suppressed', error: `Reviewed recovery queued as ${newId}`, nextRetryAt: null,
      revision: review.delivery.revision + 1 }).where(eq(schema.followingDeliveries.id, id)).run();
    tx.insert(schema.followingDeliveryApprovals).values({ id: request.approvalId, originalId: id, deliveryId: newId, createdAt: now }).run();
    return projectDelivery(tx.select().from(schema.followingDeliveries).where(eq(schema.followingDeliveries.id, newId)).get()!);
  });
}
