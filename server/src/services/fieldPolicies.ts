import { and, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { PROTECTABLE_FIELDS, type FieldPolicy } from '../contracts/metadata.js';
import { libraryMutations } from '../lib/mutations.js';
import { kavitaConnectionKey } from './kavitaState.js';
import { getKavitaConnection } from './settings.js';

export class FieldPolicyConflict extends Error {}
const connection = () => kavitaConnectionKey(getKavitaConnection().baseUrl);

const isProtectable = (field: unknown): field is typeof PROTECTABLE_FIELDS[number] => typeof field === 'string' && PROTECTABLE_FIELDS.some(f => f === field);

function parseFieldPolicyRow(row: typeof schema.seriesFieldPolicies.$inferSelect): FieldPolicy {
  const fields: unknown = JSON.parse(row.lockedFieldsJson);
  if (!Array.isArray(fields) || !(fields as unknown[]).every(isProtectable) || row.revision < 1) throw new Error('Stored field protection is invalid; repair it before syncing');
  return { lockedFields: PROTECTABLE_FIELDS.filter(field => (fields as unknown[]).includes(field)), revision: row.revision };
}

export function getFieldPolicy(seriesId: number): FieldPolicy {
  const row = getDb().select().from(schema.seriesFieldPolicies).where(and(
    eq(schema.seriesFieldPolicies.connectionKey, connection()), eq(schema.seriesFieldPolicies.seriesId, seriesId),
  )).get();
  if (!row) return { lockedFields: [], revision: 0 };
  return parseFieldPolicyRow(row);
}

/** Batch-load field protection policies for many series without N+1 SQLite queries. */
export function getFieldPolicies(seriesIds: number[]): Map<number, FieldPolicy> {
  const out = new Map<number, FieldPolicy>();
  if (!seriesIds.length) return out;
  const unique = [...new Set(seriesIds)];
  const db = getDb(), key = connection();
  for (let i = 0; i < unique.length; i += 500) {
    const rows = db.select().from(schema.seriesFieldPolicies).where(and(
      eq(schema.seriesFieldPolicies.connectionKey, key), inArray(schema.seriesFieldPolicies.seriesId, unique.slice(i, i + 500)),
    )).all();
    for (const row of rows) out.set(row.seriesId, parseFieldPolicyRow(row));
  }
  for (const seriesId of unique) if (!out.has(seriesId)) out.set(seriesId, { lockedFields: [], revision: 0 });
  return out;
}

export function saveFieldPolicy(seriesId: number, fields: unknown, expectedRevision: unknown): Promise<FieldPolicy> {
  if (!Array.isArray(fields) || !(fields as unknown[]).every(isProtectable)
      || !Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) throw new Error('Invalid field policy');
  const key = connection();
  if (!key) throw new Error('Kavita not configured');
  return libraryMutations.run([`series:${seriesId}`], async () => {
    if (connection() !== key) throw new FieldPolicyConflict('Kavita connection changed; reload protection settings');
    const current = getFieldPolicy(seriesId);
    if (current.revision !== expectedRevision) throw new FieldPolicyConflict('Protection settings changed; reload and try again');
    const lockedFields = PROTECTABLE_FIELDS.filter(field => (fields as unknown[]).includes(field));
    const revision = current.revision + 1;
    const values = { connectionKey: key, seriesId, lockedFieldsJson: JSON.stringify(lockedFields), revision, updatedAt: new Date().toISOString() };
    getDb().insert(schema.seriesFieldPolicies).values(values).onConflictDoUpdate({
      target: [schema.seriesFieldPolicies.connectionKey, schema.seriesFieldPolicies.seriesId], set: values,
    }).run();
    return { lockedFields, revision };
  });
}

/** Caller already owns the library/series boundary; never reacquire it here. */
export function inheritFieldPoliciesOwned(seriesId: number, inherited: FieldPolicy['lockedFields'], expectedConnectionKey: string, evidence?:{seriesId:number;lockedFields:FieldPolicy['lockedFields']}[]): FieldPolicy {
  if (connection() !== expectedConnectionKey) throw new FieldPolicyConflict('Kavita connection changed before protection could be transferred');
  return getDb().transaction(() => {
    const current = getFieldPolicy(seriesId);
    const sourcePolicies = evidence?.length ? getFieldPolicies(evidence.map(policy => policy.seriesId)) : undefined;
    const sourceFields=evidence ? evidence.flatMap(policy=>{const latest=sourcePolicies?.get(policy.seriesId) ?? {lockedFields:[],revision:0};return latest.revision===0 ? policy.lockedFields : latest.lockedFields;}) : inherited;
    const lockedFields = PROTECTABLE_FIELDS.filter(field => current.lockedFields.includes(field) || sourceFields.includes(field));
    if (lockedFields.length === current.lockedFields.length) return current;
    const revision = current.revision + 1;
    const values = {connectionKey:expectedConnectionKey,seriesId,lockedFieldsJson:JSON.stringify(lockedFields),revision,updatedAt:new Date().toISOString()};
    getDb().insert(schema.seriesFieldPolicies).values(values).onConflictDoUpdate({target:[schema.seriesFieldPolicies.connectionKey,schema.seriesFieldPolicies.seriesId],set:values}).run();
    return {lockedFields,revision};
  });
}
