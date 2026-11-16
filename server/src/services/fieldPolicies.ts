import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { PROTECTABLE_FIELDS, type FieldPolicy } from '../contracts/metadata.js';
import { libraryMutations } from '../lib/mutations.js';
import { kavitaConnectionKey } from './kavitaState.js';
import { getKavitaConnection } from './settings.js';

export class FieldPolicyConflict extends Error {}
const connection = () => kavitaConnectionKey(getKavitaConnection().baseUrl);

export function getFieldPolicy(seriesId: number): FieldPolicy {
  const row = getDb().select().from(schema.seriesFieldPolicies).where(and(
    eq(schema.seriesFieldPolicies.connectionKey, connection()), eq(schema.seriesFieldPolicies.seriesId, seriesId),
  )).get();
  if (!row) return { lockedFields: [], revision: 0 };
  const fields: unknown = JSON.parse(row.lockedFieldsJson);
  if (!Array.isArray(fields) || fields.some(field => !PROTECTABLE_FIELDS.includes(field)) || row.revision < 1) throw new Error('Stored field protection is invalid; repair it before syncing');
  return { lockedFields: PROTECTABLE_FIELDS.filter(field => fields.includes(field)), revision: row.revision };
}

export function saveFieldPolicy(seriesId: number, fields: unknown, expectedRevision: unknown): Promise<FieldPolicy> {
  if (!Array.isArray(fields) || fields.some(field => !PROTECTABLE_FIELDS.includes(field))
      || !Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) throw new Error('Invalid field policy');
  const key = connection();
  if (!key) throw new Error('Kavita not configured');
  return libraryMutations.run([`series:${seriesId}`], async () => {
    if (connection() !== key) throw new FieldPolicyConflict('Kavita connection changed; reload protection settings');
    const current = getFieldPolicy(seriesId);
    if (current.revision !== expectedRevision) throw new FieldPolicyConflict('Protection settings changed; reload and try again');
    const lockedFields = PROTECTABLE_FIELDS.filter(field => fields.includes(field));
    const revision = current.revision + 1;
    const values = { connectionKey: key, seriesId, lockedFieldsJson: JSON.stringify(lockedFields), revision, updatedAt: new Date().toISOString() };
    getDb().insert(schema.seriesFieldPolicies).values(values).onConflictDoUpdate({
      target: [schema.seriesFieldPolicies.connectionKey, schema.seriesFieldPolicies.seriesId], set: values,
    }).run();
    return { lockedFields, revision };
  });
}
